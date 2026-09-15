#!/usr/bin/env node
/**
 * Smoke test for freebuff-mcp.
 *
 * Covers:
 *   1. initialize + tools/list
 *   2. freebuff_status
 *   3. freebuff_run (real agent runs; sessions persist even on billing errors)
 *   4. freebuff_sessions
 *   5. resources/list + resources/read (sessions index + transcript)
 *   6. freebuff_delete (unknown id error, real delete, transcript gone)
 *   7. RESTART: a second server instance sees the surviving session on disk,
 *      serves its transcript, and the token-based resume guard works
 *      (refuses oversized sessions, resumes with force_resume).
 *
 * Usage: node test/smoke.js [agentId] [costMode]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(here, '..', 'dist', 'index.js')

// Isolated storage dir so the test is deterministic and doesn't touch real data.
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-mcp-test-'))

function startServer({ extraEnv = {} } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.join(here, '..'),
    env: { ...process.env, FREEBUFF_MCP_DIR: storageDir, ...extraEnv },
  })

  let stdoutBuf = ''
  const pending = new Map()
  let nextId = 1

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString()
    let idx
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim()
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id)
        pending.delete(msg.id)
        resolve(msg)
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[server] ${chunk}`)
  })

  const request = (method, params, timeoutMs = 120_000) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`timeout waiting for ${method}`))
        }
      }, timeoutMs)
    })
  }

  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  const stop = () => child.kill()
  return { request, notify, stop }
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`)
  console.log(`ok: ${message}`)
}

const textOf = (res) => res.result.content.map((c) => c.text).join('\n')

/** Fire a run tool call, returning the session id from the output. */
async function runAndGetSessionId(client, args) {
  const res = await client.request('tools/call', {
    name: 'freebuff_run',
    arguments: args,
  })
  const match = textOf(res).match(/session: (s_[A-Za-z0-9_-]+)/)
  if (!match) throw new Error(`no session id in run output:\n${textOf(res)}`)
  return match[1]
}

async function initialize(client) {
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.3' },
  })
  assert(init.result?.serverInfo?.name === 'freebuff-mcp', 'initialize handshake')
  client.notify('notifications/initialized', {})
}

async function main() {
  const agentId = process.argv[2]
  const costMode = process.argv[3]
  const baseRunArgs = {
    prompt:
      'Reply with a single short sentence and do nothing else. Do not read or modify any files.',
    max_steps: 3,
    timeout_seconds: 110,
  }
  if (agentId) baseRunArgs.agent = agentId
  if (costMode) baseRunArgs.cost_mode = costMode

  // ------------------------------------------------------------------
  // Instance A
  // ------------------------------------------------------------------
  console.log('=== instance A ===')
  const a = startServer()
  await initialize(a)

  const tools = await a.request('tools/list', {})
  const names = tools.result.tools.map((t) => t.name)
  assert(
    ['freebuff_run', 'freebuff_status', 'freebuff_stop', 'freebuff_delete', 'freebuff_sessions'].every(
      (n) => names.includes(n),
    ),
    'tools/list returns all five tools',
  )

  const status = await a.request('tools/call', {
    name: 'freebuff_status',
    arguments: {},
  })
  console.log('--- status:', textOf(status).split('\n').join(' | '))

  // Two runs → two independent sessions (the first gets deleted later; the
  // second survives for the restart tests).
  console.log('--- running freebuff_run twice (real agent calls)...')
  const sessionIdA1 = await runAndGetSessionId(a, { ...baseRunArgs })
  const sessionIdA2 = await runAndGetSessionId(a, { ...baseRunArgs })
  assert(sessionIdA1 !== sessionIdA2, 'two runs produce distinct session ids')

  const sessionsA = await a.request('tools/call', {
    name: 'freebuff_sessions',
    arguments: {},
  })
  assert(textOf(sessionsA).includes(sessionIdA2), 'freebuff_sessions lists sessions')
  assert(
    /~\d+ tokens/.test(textOf(sessionsA)),
    'freebuff_sessions shows token estimates',
  )

  // Resources: index + transcript
  const resList = await a.request('resources/list', {})
  const uris = resList.result.resources.map((r) => r.uri)
  assert(uris.includes('freebuff://sessions'), 'sessions index is listed')
  assert(
    uris.includes(`freebuff://sessions/${sessionIdA2}/transcript`),
    'transcript is listed',
  )

  const index = await a.request('resources/read', {
    uri: 'freebuff://sessions',
  })
  const indexJson = JSON.parse(index.result.contents[0].text)
  assert(
    indexJson.sessions.some((s) => s.id === sessionIdA2),
    'sessions index contains sessions as JSON',
  )

  const transcriptA = await a.request('resources/read', {
    uri: `freebuff://sessions/${sessionIdA2}/transcript`,
  })
  assert(
    transcriptA.result.contents[0].mimeType === 'text/markdown' &&
      transcriptA.result.contents[0].text.includes('# Freebuff session transcript'),
    'transcript resource returns markdown',
  )

  // ---------------------------- freebuff_delete ----------------------------
  const delUnknown = await a.request('tools/call', {
    name: 'freebuff_delete',
    arguments: { session_id: 's_bogus' },
  })
  assert(
    delUnknown.result.isError === true &&
      textOf(delUnknown).includes('Unknown session_id'),
    'freebuff_delete rejects unknown ids',
  )

  const delA1 = await a.request('tools/call', {
    name: 'freebuff_delete',
    arguments: { session_id: sessionIdA1 },
  })
  assert(
    textOf(delA1).includes(`Deleted session ${sessionIdA1}`),
    'freebuff_delete removes a real session',
  )

  const goneTranscript = await a.request('resources/read', {
    uri: `freebuff://sessions/${sessionIdA1}/transcript`,
  })
  assert(
    Boolean(goneTranscript.error),
    'transcript of a deleted session is gone (read errors)',
  )

  const sessionsAfterDelete = await a.request('tools/call', {
    name: 'freebuff_sessions',
    arguments: {},
  })
  const afterDeleteText = textOf(sessionsAfterDelete)
  assert(
    !afterDeleteText.includes(sessionIdA1) && afterDeleteText.includes(sessionIdA2),
    'deleted session disappears from listings, survivor remains',
  )

  a.stop()
  console.log('=== instance A stopped; starting instance B (restart + guard tests) ===')

  // ------------------------------------------------------------------
  // Instance B — same storage dir, fresh process, tiny resume ceiling so the
  // "too-large" guard path is actually exercised.
  // ------------------------------------------------------------------
  const b = startServer({
    extraEnv: { FREEBUFF_MCP_RESUME_MAX_TOKENS: '1' },
  })
  await initialize(b)

  const sessionsB = await b.request('tools/call', {
    name: 'freebuff_sessions',
    arguments: {},
  })
  assert(
    textOf(sessionsB).includes(sessionIdA2),
    'instance B lists the session created by instance A (persistence works)',
  )

  const transcriptB = await b.request('resources/read', {
    uri: `freebuff://sessions/${sessionIdA2}/transcript`,
  })
  assert(
    transcriptB.result.contents[0].text.includes('# Freebuff session transcript'),
    'instance B serves the transcript from disk',
  )

  // Resume guard: ceiling is 1 token, so every resume must be refused...
  const refused = await b.request('tools/call', {
    name: 'freebuff_run',
    arguments: {
      prompt: 'Say "resumed" and nothing else.',
      session_id: sessionIdA2,
      timeout_seconds: 10,
    },
  })
  const refusedText = textOf(refused)
  assert(
    refused.result.isError === true &&
      refusedText.includes('Refusing to resume') &&
      refusedText.includes('force_resume'),
    'resume guard refuses oversized sessions with guidance',
  )

  // ...unless force_resume is set (past the guard; agent may still fail on
  // billing, but the "Unknown session_id" / refusal path must not trigger).
  const forced = await b.request('tools/call', {
    name: 'freebuff_run',
    arguments: {
      prompt: 'Say "resumed" and nothing else.',
      session_id: sessionIdA2,
      force_resume: true,
      timeout_seconds: 10,
    },
  })
  const forcedText = textOf(forced)
  assert(
    !forcedText.includes('Refusing to resume') &&
      !forcedText.includes('Unknown session_id'),
    'force_resume bypasses the guard and reaches the agent run',
  )

  const bogus = await b.request('tools/call', {
    name: 'freebuff_run',
    arguments: { prompt: 'x', session_id: 's_bogus', timeout_seconds: 10 },
  })
  assert(
    textOf(bogus).includes('Unknown session_id'),
    'unknown session ids are still rejected',
  )

  b.stop()
  fs.rmSync(storageDir, { recursive: true, force: true })
  console.log('ALL SMOKE TESTS PASSED')
  process.exit(0)
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err)
  process.exit(1)
})
