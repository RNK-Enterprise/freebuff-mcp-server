#!/usr/bin/env node
/**
 * freebuff-mcp — drive the Freebuff coding agent from VS Code via MCP.
 *
 * Freebuff's CLI is interactive-only, but it is built on the Codebuff platform,
 * whose official SDK (@codebuff/sdk) exposes the same agent runtime
 * programmatically. This server wraps that runtime in a handful of MCP tools:
 *
 *   - freebuff_run        Run the agent against a prompt (optionally continue a session)
 *   - freebuff_status     Check auth + backend connectivity
 *   - freebuff_stop       Cancel a running agent session
 *   - freebuff_delete     Delete a session (memory + disk)
 *   - freebuff_sessions   List sessions (memory + disk) with token estimates
 *
 * MCP resources:
 *   - freebuff://sessions                     JSON index of all sessions
 *   - freebuff://sessions/{id}/transcript     Markdown transcript of a run
 *
 * Sessions persist to disk and survive server restarts.
 *
 * Auth (first match wins):
 *   1. --api-key CLI argument
 *   2. FREEBUFF_API_KEY / CODEBUFF_API_KEY environment variables
 *   3. The Freebuff CLI's stored login (~/.config/manicode/credentials.json)
 *
 * Get an API key at https://www.codebuff.com/api-keys (works with your
 * Freebuff account — Freebuff is built on the Codebuff platform).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type {
  AgentDefinition,
  CodebuffClient,
  RunState,
} from '@codebuff/sdk'
import { CodebuffClient as CodebuffClientImpl } from '@codebuff/sdk'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Logging — stderr only, stdout is reserved for the MCP protocol
// ---------------------------------------------------------------------------
const log = (...args: unknown[]) => {
  console.error('[freebuff-mcp]', ...args)
}

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

/** Where the Freebuff CLI (and legacy Codebuff CLI) store their login. */
function findCredentialsFile(): string | null {
  const dirs = [
    process.env.CODEBUFF_CONFIG_DIR,
    process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'manicode')
      : null,
    path.join(os.homedir(), '.config', 'manicode'),
    path.join(os.homedir(), '.codebuff'),
  ].filter((p): p is string => typeof p === 'string')

  for (const dir of dirs) {
    for (const name of ['credentials.json', '.credentials.json']) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

function getCredentials(): {
  authToken: string
  fingerprintId?: string
} | null {
  try {
    const file = findCredentialsFile()
    if (!file) return null
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))

    // Newer CLI versions nest credentials under a profile key ("default").
    const flat = raw as {
      authToken?: unknown
      fingerprintId?: unknown
      default?: { authToken?: unknown; fingerprintId?: unknown }
    }
    const authToken = flat?.authToken ?? flat?.default?.authToken
    const fingerprintId = flat?.fingerprintId ?? flat?.default?.fingerprintId
    if (typeof authToken === 'string' && authToken.length > 0) {
      log(`using stored credentials from ${file}`)
      return {
        authToken,
        ...(typeof fingerprintId === 'string' && fingerprintId.length > 0
          ? { fingerprintId }
          : {}),
      }
    }
    return null
  } catch {
    return null
  }
}

function resolveCredentials(): { apiKey: string; fingerprintId?: string } {
  const argIndex = process.argv.indexOf('--api-key')
  const argKey =
    argIndex !== -1 && process.argv[argIndex + 1]
      ? process.argv[argIndex + 1]
      : null
  const envKey = process.env.FREEBUFF_API_KEY ?? process.env.CODEBUFF_API_KEY

  if (argKey ?? envKey) {
    // Explicit key; still attach the CLI fingerprint if present.
    const creds = getCredentials()
    return {
      apiKey: (argKey ?? envKey) as string,
      ...(creds?.fingerprintId ? { fingerprintId: creds.fingerprintId } : {}),
    }
  }

  const creds = getCredentials()
  if (creds) {
    return {
      apiKey: creds.authToken,
      ...(creds.fingerprintId ? { fingerprintId: creds.fingerprintId } : {}),
    }
  }

  log(
    [
      'No Freebuff/Codebuff API key found.',
      '',
      'Fix it in one of three ways:',
      '  1. Log in once in a terminal:  freebuff login   (or: codebuff login)',
      '     … then restart this server so it can reuse that stored login.',
      '  2. Set CODEBUFF_API_KEY (or FREEBUFF_API_KEY) in your environment.',
      '  3. Pass --api-key <key> when launching this server.',
      '',
      'Get a key at https://www.codebuff.com/api-keys (same account as Freebuff).',
    ].join('\n'),
  )
  throw new Error(
    'No Freebuff/Codebuff API key found (see server logs for setup instructions).',
  )
}

// ---------------------------------------------------------------------------
// Read-only "ask" agent (local definition)
// ---------------------------------------------------------------------------

/**
 * codebuff/ask is not published to the public agent registry, so we ship an
 * equivalent local definition: same tool set minus anything that mutates the
 * workspace (no write_file/str_replace/apply_patch/run_terminal_command).
 */
const ASK_AGENT_ID = 'freebuff-ask'
const askAgent: AgentDefinition = {
  id: ASK_AGENT_ID,
  displayName: 'Freebuff Ask (read-only)',
  model: 'z-ai/glm-4.6',
  toolNames: ['read_files', 'list_directory', 'glob', 'code_search', 'end_turn'],
  inputSchema: {
    prompt: {
      type: 'string',
      description:
        'The question to answer or analysis to perform, using read-only tools.',
    },
  },
  instructionsPrompt: `You are a read-only research and Q&A agent embedded in a codebase.

Answer the user's question by examining the code with your read-only tools:
read_files, list_directory, glob, and code_search.

Hard rules:
- You have NO write tools. Never attempt to create, modify, or delete anything.
- Never run terminal commands; you don't have that tool.
- Ground every claim in files you actually read, citing paths (and line-ish
  context) where helpful.
- If the answer isn't in the codebase, say so plainly instead of guessing.`,
}

const DEFAULT_AGENT_ID = ASK_AGENT_ID

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

type Session = {
  runState: RunState
  cwd: string
  agent: string
  createdAt: number
  updatedAt?: number
  /** Last context-size estimate (tokens) computed when the session was saved. */
  lastEstimate?: number
}

type SessionMeta = {
  id: string
  cwd: string
  agent: string
  createdAt: number
  updatedAt: number
  outputType: string
  lastEstimate?: number
}

const STORAGE_ROOT = process.env.FREEBUFF_MCP_DIR
  ? path.resolve(process.env.FREEBUFF_MCP_DIR)
  : path.join(os.homedir(), '.freebuff-mcp')
const SESSIONS_DIR = path.join(STORAGE_ROOT, 'sessions')
const MAX_SESSIONS = positiveIntEnv('FREEBUFF_MCP_MAX_SESSIONS', 50)
const MAX_AGE_MS = positiveIntEnv('FREEBUFF_MCP_MAX_AGE_DAYS', 30) * 86_400_000
const RESUME_WARN_TOKENS = positiveIntEnv(
  'FREEBUFF_MCP_RESUME_WARN_TOKENS',
  80_000,
)
const RESUME_MAX_TOKENS = positiveIntEnv(
  'FREEBUFF_MCP_RESUME_MAX_TOKENS',
  150_000,
)

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** Only safe filename characters — also guards against path traversal. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/

function sessionPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`)
}

function ensureStorageDir(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
}

function pruneSessions(
  memory: Map<string, Session>,
): { deleted: string[]; kept: number } {
  ensureStorageDir()
  const metas: { id: string; updatedAt: number }[] = []
  for (const entry of fs.existsSync(SESSIONS_DIR)
    ? fs.readdirSync(SESSIONS_DIR)
    : []) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    if (!SESSION_ID_RE.test(id)) continue
    try {
      const raw = JSON.parse(
        fs.readFileSync(sessionPath(id), 'utf8'),
      ) as Session
      metas.push({ id, updatedAt: raw.updatedAt ?? raw.createdAt ?? 0 })
    } catch {
      // Unreadable file: leave it alone.
    }
  }

  const now = Date.now()
  const deleted: string[] = []

  // Age-based prune.
  const expired = metas.filter((m) => now - m.updatedAt > MAX_AGE_MS)
  for (const m of expired) {
    try {
      fs.unlinkSync(sessionPath(m.id))
      deleted.push(m.id)
    } catch {
      // best effort
    }
  }

  // Count-based prune (oldest first).
  const surviving = metas
    .filter((m) => !deleted.includes(m.id))
    .sort((a, b) => a.updatedAt - b.updatedAt)
  while (surviving.length > MAX_SESSIONS) {
    const oldest = surviving.shift()
    if (!oldest) break
    try {
      fs.unlinkSync(sessionPath(oldest.id))
      deleted.push(oldest.id)
    } catch {
      // best effort
    }
  }

  for (const id of deleted) memory.delete(id)
  return { deleted, kept: surviving.length }
}

function persistSession(id: string, session: Session): void {
  ensureStorageDir()
  // Store the context-size estimate with the session so listings and resume
  // checks are cheap after restarts.
  session.lastEstimate = estimateSessionTokens(session)
  const file = sessionPath(id)
  const payload = JSON.stringify(session)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, payload)
    fs.renameSync(tmp, file)
    session.updatedAt = Date.now()
  } catch (error) {
    log(`failed to persist session ${id}:`, error)
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      // best effort
    }
  }
  const { deleted } = pruneSessions(sessions)
  if (deleted.length > 0) log(`pruned ${deleted.length} old session(s)`)
}

function loadSessionFromDisk(id: string): Session | null {
  if (!SESSION_ID_RE.test(id)) return null
  const file = sessionPath(id)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Session
  } catch (error) {
    log(`failed to load session ${id} from disk:`, error)
    return null
  }
}

function listSessionsFromDisk(): SessionMeta[] {
  ensureStorageDir()
  const metas: SessionMeta[] = []
  for (const entry of fs.readdirSync(SESSIONS_DIR)) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    if (!SESSION_ID_RE.test(id)) continue
    const session = loadSessionFromDisk(id)
    if (!session) continue
    metas.push({
      id,
      cwd: session.cwd,
      agent: session.agent,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt ?? session.createdAt,
      outputType: session.runState?.output?.type ?? 'unknown',
      ...(session.lastEstimate != null
        ? { lastEstimate: session.lastEstimate }
        : {}),
    })
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ---------------------------------------------------------------------------
// Client + session management
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>()
let activeRun: { sessionId: string; abort: AbortController } | null = null

let clientPromise: Promise<CodebuffClient> | null = null

function getClient(): Promise<CodebuffClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { apiKey, fingerprintId } = resolveCredentials()
      return new CodebuffClientImpl({
        apiKey,
        ...(fingerprintId ? { fingerprintId } : {}),
        cwd: process.cwd(),
        agentDefinitions: [askAgent],
        logger: {
          debug: () => {},
          info: (data: unknown, msg?: string) => log('info:', data, msg ?? ''),
          warn: (data: unknown, msg?: string) => log('warn:', data, msg ?? ''),
          error: (data: unknown, msg?: string) => log('error:', data, msg ?? ''),
        },
      })
    })().catch((err) => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

/** Memory first, then disk (disk sessions are cached into memory). */
function getSession(id: string): Session | null {
  const inMemory = sessions.get(id)
  if (inMemory) return inMemory
  const fromDisk = loadSessionFromDisk(id)
  if (fromDisk) sessions.set(id, fromDisk)
  return fromDisk
}

/** Remove a session from memory and disk. Returns false if it never existed. */
function deleteSession(id: string): boolean {
  const existedInMemory = sessions.delete(id)
  if (!SESSION_ID_RE.test(id)) return existedInMemory
  const file = sessionPath(id)
  let existedOnDisk = false
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file)
      existedOnDisk = true
    } catch (error) {
      log(`failed to delete session file ${file}:`, error)
    }
  }
  return existedInMemory || existedOnDisk
}

// ---------------------------------------------------------------------------
// Context-size estimation + resume guard
// ---------------------------------------------------------------------------

/**
 * Rough context-size estimate (in tokens) for a stored session.
 *
 * The backend applies its own truncation/compaction, so this is intentionally
 * conservative (an upper bound), character-based, and cheap to compute on
 * load: ~4 chars/token for text parts and JSON tool payloads.
 */
function estimateSessionTokens(session: Session): number {
  const history = messageHistoryOf(session)
  let chars = 0
  for (const message of history) {
    const parts = (message.content ?? []) as unknown[]
    for (const part of parts) {
      if (part == null) continue
      if (typeof part === 'string') {
        chars += part.length
        continue
      }
      if (typeof part === 'object') {
        const obj = part as { text?: unknown }
        if (typeof obj.text === 'string') {
          chars += obj.text.length
          continue
        }
        chars += JSON.stringify(part).length
      }
    }
  }
  return Math.ceil(chars / 4)
}

type ResumeCheck = {
  estimate: number
  /** null = proceed; otherwise a short code for the UI/tests. */
  problem: 'too-large' | null
  message: string | null
}

/** Guard applied before resuming a persisted session. */
function checkResume(session: Session): ResumeCheck {
  const estimate =
    session.lastEstimate ?? estimateSessionTokens(session)
  if (estimate > RESUME_MAX_TOKENS) {
    return {
      estimate,
      problem: 'too-large',
      message: `Session is estimated at ~${estimate} tokens, above the resume ceiling of ${RESUME_MAX_TOKENS} (FREEBUFF_MCP_RESUME_MAX_TOKENS). Starting a fresh session is recommended. Pass force_resume: true to continue anyway.`,
    }
  }
  if (estimate > RESUME_WARN_TOKENS) {
    return {
      estimate,
      problem: null,
      message: `Warning: session is estimated at ~${estimate} tokens (warn threshold ${RESUME_WARN_TOKENS}, configurable via FREEBUFF_MCP_RESUME_WARN_TOKENS).`,
    }
  }
  return { estimate, problem: null, message: null }
}

// ---------------------------------------------------------------------------
// Output + transcript formatting
// ---------------------------------------------------------------------------

type OutputText = { type: string; text: string }

/** Minimal structural view of the SDK's message history (not exported). */
type HistoryMessage =
  | { role: 'system'; content?: unknown }
  | { role: 'user'; content?: unknown }
  | {
      role: 'assistant'
      content?: ({ type?: string; text?: string } & Record<string, unknown>)[]
    }
  | { role: 'tool'; toolName?: string; content?: unknown }
  | { role: string; content?: unknown }

function messageHistoryOf(session: Session): HistoryMessage[] {
  const state = session.runState?.sessionState as
    | {
        mainAgentState?: { messageHistory?: HistoryMessage[] }
      }
    | undefined
  return state?.mainAgentState?.messageHistory ?? []
}

function extractOutputText(output: RunState['output']): OutputText {
  if (output.type === 'error') {
    return { type: output.type, text: `Agent error: ${output.message}` }
  }
  if (output.type === 'structuredOutput' && output.value) {
    return {
      type: output.type,
      text: JSON.stringify(output.value, null, 2),
    }
  }
  if (output.type === 'lastMessage' || output.type === 'allMessages') {
    const text = output.value
      .filter(
        (part: unknown): part is { type: 'text'; text: string } =>
          (part as { type?: string } | null)?.type === 'text',
      )
      .map((part: { type: 'text'; text: string }) => part.text)
      .join('\n')
    return { type: output.type, text }
  }
  return { type: output.type, text: '' }
}

function textPartsOf(message: {
  content?: unknown
}): string {
  const parts = (message.content ?? []) as { type?: string; text?: string }[]
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}

function buildTranscript(id: string, session: Session): string {
  const lines: string[] = []
  const meta: SessionMeta = {
    id,
    cwd: session.cwd,
    agent: session.agent,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt ?? session.createdAt,
    outputType: session.runState?.output?.type ?? 'unknown',
  }

  lines.push('# Freebuff session transcript', '')
  lines.push(`- session: ${meta.id}`)
  lines.push(`- agent: ${meta.agent}`)
  lines.push(`- cwd: ${meta.cwd}`)
  lines.push(`- created: ${new Date(meta.createdAt).toISOString()}`)
  lines.push(`- updated: ${new Date(meta.updatedAt).toISOString()}`)
  lines.push(`- final output: ${meta.outputType}`)
  lines.push('')

  const history = messageHistoryOf(session)

  if (history.length === 0) {
    lines.push('(no message history recorded)', '')
  }

  for (const message of history) {
    switch (message.role) {
      case 'system':
        // Internal; omit from transcripts.
        break
      case 'user': {
        const text = textPartsOf(message)
        lines.push('## user', '', text || '(empty)', '')
        break
      }
      case 'assistant': {
        lines.push('## assistant', '')
        const parts = (message.content ?? []) as {
          type?: string
          text?: string
          toolName?: string
          input?: unknown
        }[]
        for (const part of parts) {
          if (part.type === 'text' && part.text) {
            lines.push(part.text, '')
          } else if (part.type === 'tool-call') {
            lines.push(
              `- calls tool \`${part.toolName}\` with \`${JSON.stringify(part.input).slice(0, 300)}\``,
              '',
            )
          }
          // reasoning parts are omitted
        }
        break
      }
      case 'tool': {
        const toolName =
          (message as { toolName?: string }).toolName ?? 'unknown'
        lines.push(`### tool result: ${toolName}`, '')
        lines.push(
          '```json',
          JSON.stringify(message.content, null, 2).slice(0, 1500),
          '```',
          '',
        )
        break
      }
      default:
        break
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Agent run
// ---------------------------------------------------------------------------

type AgentRunResult = {
  ok: boolean
  text: string
  activity: string[]
  outputType: string
  creditsUsed?: number
  runState: RunState
}

/** Run the agent, collecting assistant text + tool activity into a summary. */
async function runAgent(
  prompt: string,
  opts: {
    cwd?: string
    agent?: string
    previousRun?: RunState
    maxSteps?: number
    signal?: AbortSignal
    costMode?: string
  },
): Promise<AgentRunResult> {
  const client = await getClient()

  const activity: string[] = []
  const runState = await client.run({
    agent: opts.agent ?? DEFAULT_AGENT_ID,
    prompt,
    previousRun: opts.previousRun,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.maxSteps ? { maxAgentSteps: opts.maxSteps } : {}),
    ...(opts.costMode ? { costMode: opts.costMode } : {}),
    signal: opts.signal,
    handleEvent: (event) => {
      switch (event.type) {
        case 'text':
          activity.push(`assistant: ${event.text}`)
          break
        case 'tool_call': {
          const input = event.input as Record<string, unknown>
          const detail =
            (typeof input.command === 'string' && input.command) ||
            (typeof input.filePath === 'string' && input.filePath) ||
            (Array.isArray(input.filePaths) && input.filePaths.join(', ')) ||
            (typeof input.path === 'string' && input.path) ||
            (typeof input.pattern === 'string' && input.pattern) ||
            ''
          activity.push(
            `tool: ${event.toolName}${detail ? ` (${String(detail).slice(0, 200)})` : ''}`,
          )
          break
        }
        case 'tool_result':
          // Full tool outputs are usually too large; the tool_call line suffices.
          break
        case 'error':
          activity.push(`error: ${event.message}`)
          break
        case 'subagent_start':
          activity.push(`subagent started: ${event.displayName}`)
          break
        case 'subagent_finish':
          activity.push(`subagent finished: ${event.displayName}`)
          break
        default:
          // start / finish / download / reasoning_delta are informational only.
          break
      }
    },
  })

  const { type: outputType, text } = extractOutputText(runState.output)
  const ok = runState.output.type !== 'error'
  const creditsUsed =
    runState.sessionState?.mainAgentState?.creditsUsed ?? undefined

  return {
    ok,
    text: text || '(no assistant text output)',
    activity,
    outputType,
    creditsUsed,
    runState,
  }
}

// ---------------------------------------------------------------------------
// MCP server + tools + resources
// ---------------------------------------------------------------------------

async function main() {
  const server = new McpServer({
    name: 'freebuff-mcp',
    version: '0.3.0',
  })

  // ------------------------------ freebuff_run ------------------------------
  server.tool(
    'freebuff_run',
    `Run the Freebuff coding agent on a prompt, inside a workspace folder.

By default runs the built-in read-only 'freebuff-ask' agent, which can read
files, search code, and answer questions but cannot modify anything — safe for
codebase Q&A. Pass agent: 'codebuff/base@0.0.16' to let the agent edit files
and run commands.

Returns the agent's final answer plus a log of what it did. Continue a
conversation by passing the session_id returned from a previous run (sessions
persist across server restarts).`,
    {
      prompt: z.string().min(1).describe('What you want the agent to do.'),
      cwd: z
        .string()
        .optional()
        .describe(
          'Working directory for the run. Defaults to the folder this server was started in.',
        ),
      agent: z
        .string()
        .optional()
        .describe(
          `Agent id to run. Defaults to '${DEFAULT_AGENT_ID}' (read-only). Use 'codebuff/base@0.0.16' for full edit/terminal capability.`,
        ),
      session_id: z
        .string()
        .optional()
        .describe(
          'A session id returned by a previous freebuff_run call, to continue that conversation.',
        ),
      max_steps: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Cap on agent steps to avoid runaway runs. Default 40.'),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(1200)
        .optional()
        .describe('Hard timeout for this run. Default 300 (5 minutes).'),
      cost_mode: z
        .enum(['free', 'normal', 'max', 'experimental', 'ask'])
        .optional()
        .describe(
          "Billing tier. 'free' routes to free-tier models (like the CLI's --lite mode); 'normal' uses the standard paid path.",
        ),
      force_resume: z
        .boolean()
        .optional()
        .describe(
          'Resume even when the persisted session is estimated above the token ceiling (FREEBUFF_MCP_RESUME_MAX_TOKENS).',
        ),
    },
    async ({
      prompt,
      cwd,
      agent,
      session_id,
      max_steps,
      timeout_seconds,
      cost_mode,
      force_resume,
    }) => {
      let sessionId = session_id
      let previousRun: RunState | undefined
      let resumeWarning: string | null = null
      const runCwd = cwd ?? process.cwd()
      const runAgentId = agent ?? DEFAULT_AGENT_ID

      if (sessionId) {
        const session = getSession(sessionId)
        if (!session) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown session_id: ${sessionId}. Known sessions: ${[...sessions.keys()].join(', ') || '(none)'}.`,
              },
            ],
            isError: true,
          }
        }
        // Token-based resume guard: refuse oversized sessions unless forced.
        const check = checkResume(session)
        if (check.problem === 'too-large' && !force_resume) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Refusing to resume ${sessionId}: ${check.message}\n\nPass force_resume: true to continue anyway, or start a new session.`,
              },
            ],
            isError: true,
          }
        }
        if (check.message && !check.problem) {
          resumeWarning = check.message
        } else if (check.problem === 'too-large' && force_resume) {
          resumeWarning = `Forced resume: ${check.message}`
        }
        previousRun = session.runState
      }

      // One abort controller per run; freebuff_stop cancels the active one.
      const abort = new AbortController()
      activeRun = { sessionId: sessionId ?? '', abort }
      const timeoutMs = (timeout_seconds ?? 300) * 1000
      const timer = setTimeout(() => abort.abort(), timeoutMs)

      try {
        const result = await runAgent(prompt, {
          cwd: runCwd,
          agent: runAgentId,
          previousRun,
          maxSteps: max_steps ?? 40,
          signal: abort.signal,
          costMode: cost_mode,
        })

        if (!sessionId) {
          sessionId = `s_${Date.now().toString(36)}_${Math.random()
            .toString(36)
            .slice(2, 8)}`
        }
        const session: Session = {
          runState: result.runState,
          cwd: runCwd,
          agent: runAgentId,
          createdAt: sessions.get(sessionId)?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        }
        sessions.set(sessionId, session)
        persistSession(sessionId, session)

        const lines = [
          `session: ${sessionId} (cwd: ${runCwd}, agent: ${runAgentId})`,
        ]
        if (resumeWarning) lines.push('', resumeWarning)
        lines.push('', result.text)
        if (result.activity.length > 0) {
          lines.push('', '--- activity ---', ...result.activity.slice(-25))
        }
        lines.push(
          '',
          `(${result.outputType}${typeof result.creditsUsed === 'number' ? `, credits used: ${result.creditsUsed}` : ''})`,
          `transcript: freebuff://sessions/${sessionId}/transcript`,
        )

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          isError: !result.ok,
        }
      } finally {
        clearTimeout(timer)
        if (activeRun?.abort === abort) activeRun = null
      }
    },
  )

  // ---------------------------- freebuff_status -----------------------------
  server.tool(
    'freebuff_status',
    'Check whether the Freebuff MCP server has valid credentials and can reach the agent backend.',
    {},
    async () => {
      try {
        const client = await getClient()
        const connected = await client.checkConnection()
        const credFile = findCredentialsFile()
        const text = [
          `backend reachable: ${connected ? 'yes' : 'no'}`,
          `auth source: ${
            process.argv.includes('--api-key')
              ? '--api-key argument'
              : process.env.FREEBUFF_API_KEY || process.env.CODEBUFF_API_KEY
                ? 'environment variable'
                : credFile
                  ? `stored login (${credFile})`
                  : 'unknown'
          }`,
          `sessions in memory: ${sessions.size}`,
          `sessions on disk: ${listSessionsFromDisk().length}`,
          `storage dir: ${SESSIONS_DIR}`,
          `default agent: ${DEFAULT_AGENT_ID} (read-only)`,
        ].join('\n')
        return {
          content: [{ type: 'text' as const, text }],
          isError: !connected,
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Not ready: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  // ---------------------------- freebuff_delete -----------------------------
  server.tool(
    'freebuff_delete',
    `Delete a Freebuff agent session by id — from memory and disk.

Returns error if the id is unknown. The transcript resource for a deleted
session disappears; active runs must be cancelled (freebuff_stop) before
deleting their session.`,
    {
      session_id: z
        .string()
        .min(1)
        .describe('Id of the session to delete (see freebuff_sessions).'),
    },
    async ({ session_id }) => {
      if (
        activeRun &&
        session_id &&
        activeRun.sessionId === session_id
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Session ${session_id} has a run in progress; call freebuff_stop first.`,
            },
          ],
          isError: true,
        }
      }
      if (!deleteSession(session_id)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unknown session_id: ${session_id}. Known sessions: ${[...new Set([...sessions.keys(), ...listSessionsFromDisk().map((m) => m.id)])].join(', ') || '(none)'}.`,
            },
          ],
          isError: true,
        }
      }
      log(`deleted session ${session_id}`)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Deleted session ${session_id} (removed from memory and disk).`,
          },
        ],
      }
    },
  )

  // ----------------------------- freebuff_stop ------------------------------
  server.tool(
    'freebuff_stop',
    'Cancel the currently running Freebuff agent session, if any.',
    {},
    async () => {
      if (!activeRun) {
        return {
          content: [
            { type: 'text' as const, text: 'No agent run in progress.' },
          ],
        }
      }
      activeRun.abort.abort()
      const sessionId = activeRun.sessionId
      activeRun = null
      return {
        content: [
          {
            type: 'text' as const,
            text: `Cancelled run for ${sessionId || 'current session'}.`,
          },
        ],
      }
    },
  )

  // ---------------------------- freebuff_sessions ---------------------------
  server.tool(
    'freebuff_sessions',
    'List Freebuff agent sessions known to this server (memory + persisted on disk).',
    {},
    async () => {
      const merged = new Map<string, SessionMeta>()
      for (const meta of listSessionsFromDisk()) merged.set(meta.id, meta)
      for (const [id, s] of sessions) {
        merged.set(id, {
          id,
          cwd: s.cwd,
          agent: s.agent,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt ?? s.createdAt,
          outputType: s.runState?.output?.type ?? 'unknown',
          ...(s.lastEstimate != null ? { lastEstimate: s.lastEstimate } : {}),
        })
      }
      if (merged.size === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No sessions yet.' }],
        }
      }
      const lines = [...merged.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((m) => {
          const est =
            m.lastEstimate != null ? `, ~${m.lastEstimate} tokens` : ''
          return `${m.id}  (agent: ${m.agent}, output: ${m.outputType}${est}, cwd: ${m.cwd}, updated: ${new Date(m.updatedAt).toISOString()})`
        })
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    },
  )

  // ----------------------------- resources ----------------------------------
  // Static: JSON index of all sessions.
  server.registerResource(
    'sessions-index',
    'freebuff://sessions',
    {
      description:
        'JSON index of all Freebuff agent sessions (persisted + in-memory).',
      mimeType: 'application/json',
    },
    async (uri) => {
      const merged = new Map<string, SessionMeta>()
      for (const meta of listSessionsFromDisk()) merged.set(meta.id, meta)
      for (const [id, s] of sessions) {
        merged.set(id, {
          id,
          cwd: s.cwd,
          agent: s.agent,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt ?? s.createdAt,
          outputType: s.runState?.output?.type ?? 'unknown',
          ...(s.lastEstimate != null
            ? { lastEstimate: s.lastEstimate }
            : {}),
        })
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              { sessions: [...merged.values()] },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // Template: markdown transcript per session.
  const transcriptTemplate = new ResourceTemplate(
    'freebuff://sessions/{id}/transcript',
    {
      list: async () => ({
        resources: listSessionsFromDisk().map((meta) => ({
          uri: `freebuff://sessions/${meta.id}/transcript`,
          name: `Transcript: ${meta.id}`,
          description: `Agent ${meta.agent}, last output: ${meta.outputType}`,
          mimeType: 'text/markdown',
        })),
      }),
    },
  )

  server.registerResource(
    'session-transcript',
    transcriptTemplate,
    {
      description:
        'Markdown transcript of a Freebuff agent session (user/assistant/tool messages).',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const rawId = variables.id
      const id = decodeURIComponent(
        Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? ''),
      )
      const session = getSession(id)
      if (!session) {
        throw new Error(`Unknown session: ${id}`)
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: buildTranscript(id, session),
          },
        ],
      }
    },
  )

  // -------------------------------------------------------------------------
  // Start stdio transport
  // -------------------------------------------------------------------------
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(`server started on stdio (sessions dir: ${SESSIONS_DIR})`)
}

main().catch((error) => {
  log('fatal:', error instanceof Error ? error.stack : error)
  process.exit(1)
})
