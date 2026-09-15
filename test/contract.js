#!/usr/bin/env node
/**
 * Contract test for freebuff-mcp's client-facing surface.
 *
 * Spawns the built server and pins what MCP clients actually depend on:
 *   - tool names and their input schemas (parameter names, types, required
 *     lists, constraints such as minimum/maximum/enum/default)
 *   - resource URIs and resource-template URI templates
 *
 * It deliberately does NOT pin description/title prose: those are model-facing
 * copy that should be free to improve without failing CI. Everything
 * structural is compared exactly, so an accidental rename or dropped
 * parameter fails here instead of silently breaking clients.
 *
 * Usage:
 *   node test/contract.js            # verify against the snapshot
 *   node test/contract.js --update   # rewrite the snapshot (intentional change)
 *
 * Requires a build first (`npm run build`).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const serverPath = path.join(root, 'dist', 'index.js')
const snapshotPath = path.join(here, 'contract.snapshot.json')

const update = process.argv.includes('--update')

if (!fs.existsSync(serverPath)) {
  console.error(`missing ${serverPath} — run "npm run build" first`)
  process.exit(1)
}

/** Prose that is not part of the structural contract. */
const PROSE_KEYS = new Set(['description', 'title'])

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (PROSE_KEYS.has(key)) continue
      out[key] = normalize(value[key])
    }
    return out
  }
  return value
}

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-mcp-contract-'))

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: root,
    env: { ...process.env, FREEBUFF_MCP_DIR: storageDir },
  })

  let buf = ''
  const pending = new Map()
  let nextId = 1

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })

  // Server diagnostics go to stderr; keep them out of the test output unless
  // something fails, to keep CI logs readable.
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))

  const request = (method, params, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`timeout waiting for ${method}`))
        }
      }, timeoutMs)
    })

  return { child, request, stderr }
}

/** Recursively collect differences between two normalized values. */
function diff(expected, actual, at = '', out = []) {
  if (expected === actual) return out
  const bothObjects =
    expected && actual && typeof expected === 'object' && typeof actual === 'object'
  if (!bothObjects) {
    out.push(`  ${at || '(root)'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    return out
  }
  const expectedKeys = Object.keys(expected)
  const actualKeys = Object.keys(actual)
  for (const key of expectedKeys.filter((k) => !actualKeys.includes(k))) {
    out.push(`  ${at}.${key}: missing (snapshot has ${JSON.stringify(expected[key])})`)
  }
  for (const key of actualKeys.filter((k) => !expectedKeys.includes(k))) {
    out.push(`  ${at}.${key}: unexpected ${JSON.stringify(actual[key])}`)
  }
  for (const key of expectedKeys.filter((k) => actualKeys.includes(k))) {
    const next = at ? `${at}.${key}` : key
    if (Array.isArray(expected[key]) && Array.isArray(actual[key])) {
      if (expected[key].length !== actual[key].length) {
        out.push(
          `  ${next}: expected ${expected[key].length} entries, got ${actual[key].length}` +
            ` (expected [${expected[key].map((v) => v?.name ?? v?.uri ?? v?.uriTemplate ?? '?').join(', ')}],` +
            ` got [${actual[key].map((v) => v?.name ?? v?.uri ?? v?.uriTemplate ?? '?').join(', ')}])`,
        )
        continue
      }
      expected[key].forEach((value, i) => diff(value, actual[key][i], `${next}[${i}]`, out))
      continue
    }
    diff(expected[key], actual[key], next, out)
  }
  return out
}

const { child, request, stderr } = startServer()

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'contract-test', version: '1.0.0' },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const tools = await request('tools/list', {})
  const resources = await request('resources/list', {})
  const templates = await request('resources/templates/list', {})

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const serverInfo = init.result?.serverInfo ?? {}

  const actual = {
    serverInfo: { name: serverInfo.name },
    tools: normalize(
      (tools.result?.tools ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    ),
    resources: normalize(
      (resources.result?.resources ?? [])
        .map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType }))
        .sort((a, b) => a.uri.localeCompare(b.uri)),
    ),
    resourceTemplates: normalize(
      (templates.result?.resourceTemplates ?? [])
        .map((t) => ({ uriTemplate: t.uriTemplate, name: t.name, mimeType: t.mimeType }))
        .sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate)),
    ),
  }

  const failures = []

  // The version the server advertises must match what is published, otherwise
  // clients report a version that no longer corresponds to the code.
  if (serverInfo.version !== pkg.version) {
    failures.push(
      `  serverInfo.version: expected ${JSON.stringify(pkg.version)} (package.json), got ${JSON.stringify(serverInfo.version)}`,
    )
  }

  if (update) {
    fs.writeFileSync(snapshotPath, JSON.stringify(actual, null, 2) + '\n')
    console.log(`contract snapshot written: ${path.relative(root, snapshotPath)}`)
    console.log(
      `pinned: ${actual.tools.length} tools, ${actual.resources.length} resources, ${actual.resourceTemplates.length} resource templates`,
    )
  } else {
    const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
    failures.push(...diff(expected, actual))

    if (failures.length) {
      console.error('CONTRACT TEST FAILED — the client-facing surface changed:\n')
      console.error(failures.slice(0, 40).join('\n'))
      if (failures.length > 40) console.error(`  … and ${failures.length - 40} more`)
      console.error(
        '\nIf this change is intentional, review it as a breaking API change and update the snapshot:\n' +
          '  npm run build && npm run test:contract -- --update\n',
      )
      if (stderr.length) console.error('server stderr:\n' + stderr.join(''))
      process.exit(1)
    }

    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
    console.log(
      `contract holds: ${count(actual.tools.length, 'tool')}, ${count(actual.resources.length, 'resource')}, ${count(actual.resourceTemplates.length, 'resource template')}`,
    )
  }
} catch (err) {
  console.error(`contract test error: ${err.message}`)
  if (stderr.length) console.error('server stderr:\n' + stderr.join(''))
  process.exit(1)
} finally {
  child.kill('SIGTERM')
  fs.rmSync(storageDir, { recursive: true, force: true })
}
