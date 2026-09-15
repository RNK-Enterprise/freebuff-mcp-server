# freebuff-mcp-server

Run the **Freebuff** coding agent from inside **VS Code** (or any MCP client)
via the Model Context Protocol. Delegate coding tasks to the agent without
leaving the editor.

## Tools

| Tool                | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `freebuff_run`      | Run the agent on a prompt. Sessions are continuable via `session_id`. |
| `freebuff_status`   | Check auth + backend connectivity + storage info.                         |
| `freebuff_stop`     | Cancel the in-flight run.                                                 |
| `freebuff_delete`   | Delete a session by id (memory + disk).                                   |
| `freebuff_sessions` | List sessions (memory + disk) with token-size estimates.                  |

`freebuff_run` options: `prompt` (required), `cwd`, `agent`, `session_id`,
`max_steps`, `timeout_seconds`, `cost_mode` (`free` ≈ the CLI's `--lite`
mode), `force_resume`.

### Safe-by-default: read-only ask agent

By default `freebuff_run` uses a built-in local agent, **`freebuff-ask`**
(read-only): it can `read_files`, `list_directory`, `glob`, and `code_search`,
but has **no write or terminal tools**, so it can't modify your workspace.
Ideal for codebase Q&A like "where is the auth middleware?" or "why does this
test fail?".

> `codebuff/ask` is not published to the public agent registry, so this server
> ships its own equivalent definition (`z-ai/glm-4.6`).

To let the agent **edit files and run commands**, pass
`agent: 'codebuff/base@0.0.16'` explicitly.

## MCP resources

| URI                                      | What it is                                     |
| ---------------------------------------- | ---------------------------------------------- |
| `freebuff://sessions`                     | JSON index of all sessions.                    |
| `freebuff://sessions/{id}/transcript`     | Markdown transcript (user/assistant/tool messages). |

Transcripts appear in `resources/list`, so MCP clients can browse past runs.

## Session persistence & resume guard

Sessions are written to disk after every run and survive server restarts:

- Default location: `~/.freebuff-mcp/sessions/<id>.json`
- Override with `FREEBUFF_MCP_DIR` (directory) — the test suite uses this
- Pruning: keep at most `FREEBUFF_MCP_MAX_SESSIONS` (default 50), delete older
  than `FREEBUFF_MCP_MAX_AGE_DAYS` (default 30); runs on every save
- Restarts: pass a previous `session_id` to `freebuff_run` in a brand-new
  server process — it loads from disk and continues the conversation

Because agent context windows are finite, resuming is guarded by a
character-based token estimate (~4 chars/token, an upper bound — the backend
still does its own truncation/compaction):

| Env var                          | Default | Behavior                                   |
| -------------------------------- | ------- | ------------------------------------------ |
| `FREEBUFF_MCP_RESUME_WARN_TOKENS`  | 80000   | Warn when resuming above this size         |
| `FREEBUFF_MCP_RESUME_MAX_TOKENS`   | 150000  | Refuse to resume above this unless `force_resume: true` |

Estimates are stored with each session and shown by `freebuff_sessions`
(`~12345 tokens`), so oversized sessions are visible before you try.

## Installation

Published as [`freebuff-mcp-server`](https://www.npmjs.com/package/freebuff-mcp-server).
Use it directly with npx (no clone needed):

```bash
npx -y freebuff-mcp-server
```

Or install globally:

```bash
npm install -g freebuff-mcp-server
freebuff-mcp-server
```

### Authentication

Get an API key at **https://www.codebuff.com/api-keys** (same account as your
Freebuff login), then supply it in one of these ways (first match wins):

1. `--api-key <key>` argument
2. `FREEBUFF_API_KEY` or `CODEBUFF_API_KEY` environment variable
3. Your existing Freebuff CLI login (`~/.config/manicode/credentials.json`) —
   tried automatically as a fallback

> **Note (verified experimentally, Sept 2026):** the stored CLI session token
> authenticates and reaches the backend, but SDK runs are billed through the
> Codebuff API-key path, so it currently yields `Payment Required` (normal
> mode) or `Forbidden` (`cost_mode: "free"`). Generate an API key at the link
> above and the server works out of the box. If your account has no SDK
> access, that's an account/billing matter on codebuff.com — there is no
> free headless path in the Freebuff CLI itself today.

### Use in VS Code

A ready-made config is included at `.vscode/mcp.json` (workspace root). It
launches the server via `npx` and prompts for your API key on first use:

```json
{
  "servers": {
    "freebuff": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "freebuff-mcp-server"],
      "env": { "CODEBUFF_API_KEY": "${input:codebuffApiKey}" }
    }
  }
}
```

For any other MCP client, the launch command is the same:
`npx -y freebuff-mcp-server`.

## Publishing (maintainers)

Publishing is automated from GitHub releases:

1. Authenticate publishing — either works, and npm tries OIDC first:
   - **npm trusted publishing (preferred, no secret):** on npmjs.com add a
     trusted publisher for this repo (`publish.yml` workflow) under the
     package's Settings → Trusted publishing. Requires npm CLI ≥ 11.5.1 and
     Node ≥ 22.14, which the workflow provides by running Node 24.
   - **`NPM_TOKEN` fallback:** add an npm automation/granular token as a
     repository secret (needed for the very first publish, before the package
     exists on npm and a trusted publisher can be configured)
2. Bump `package.json` version, commit, and tag it
3. Create a GitHub release with tag `v<version>` (e.g. `v0.3.1`)

The `publish.yml` workflow then typechecks, builds, runs the protocol-only
smoke test, verifies the tag matches the package version, reports which
credential path is in use, and runs `npm publish --provenance --access public`.
Re-running a stuck publish does not need a new release: dispatch the workflow
against the release tag (`gh workflow run publish.yml --ref v<version>`).

Manual publish still works: `npm publish` (prepublishOnly re-runs typecheck +
build). The tarball contains only `dist/` + `README.md` (~12 kB packed).

## CI

`.github/workflows/ci.yml` runs on every push/PR touching `src/`, `test/`
(Node 20 + 22): `npm run audit:runtime` (fails on runtime-scope advisories)
→ typecheck → build → `npm test` with `SMOKE_SKIP_NETWORK=1`.
That mode exercises the full MCP protocol surface (handshake, tool schemas,
resource listing/reads, delete and resume error paths, persistence across a
restart) without agent runs, since CI has no credentials. The full test with
real agent runs still works locally: `npm test`.

## Development

```bash
npm install
npm run typecheck       # tsc --noEmit
npm run build           # emit dist/index.js
npm run audit:runtime   # fail on runtime-scope advisories (AUDIT_MIN_SEVERITY=high to raise the bar)
node test/smoke.js  # full end-to-end test (see below)
                    # optional args: [agentId] [costMode]
```

The smoke test exercises: initialize → tools/list → status → two real agent
runs → sessions list (with token estimates) → `resources/list` +
`resources/read` (index + transcript) → `freebuff_delete` (unknown id, real
delete, transcript gone) → **restart**: a second server instance must list the
surviving session, serve its transcript from disk, refuse an oversized resume
(`FREEBUFF_MCP_RESUME_MAX_TOKENS=1`), resume with `force_resume`, and still
reject unknown ids.

stdout is reserved for the MCP protocol; all diagnostics go to stderr.

## Status & limitations

- The MCP layer (tools, resources, persistence, resume guard, cancellation,
  timeouts) is complete and tested against a live server.
- Runs require a Codebuff API key with SDK access (see Authentication).
- Transcripts omit `system` messages and reasoning parts.
- Token estimates are character-based upper bounds, not exact counts.
- `undici` and `@ai-sdk/provider-utils` are pinned to patched versions via npm
  `overrides` in `package.json` (transitive deps of `@codebuff/sdk`); revisit
  these pins when the SDK ships a dependency refresh.
