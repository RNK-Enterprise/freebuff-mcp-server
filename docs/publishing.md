# Publishing `freebuff-mcp-server`

How releases reach npm, and the options evaluated for doing it without a
long-lived credential.

## Current flow

`publish.yml` publishes when a GitHub release is published, and can also be
dispatched manually against a release tag:

```bash
gh workflow run publish.yml --ref v0.3.1     # direct publish
gh workflow run publish.yml --ref v0.3.1 -f staging=true   # staged publish
```

It typechecks, builds, runs the protocol-only smoke suite, verifies the tag
matches `package.json`, reports which credential path is in use, and then
publishes (`npm publish`) or stages (`npm stage publish`).

## Why this existed as a problem

The first publish stalled repeatedly: the workflow needs a credential, and
`NPM_TOKEN` was never present (`NODE_AUTH_TOKEN` empty → `ENEEDAUTH`). A
long-lived npm token in repo secrets is also the weakest part of the supply
chain — it is broadly scoped, survives indefinitely, and is not tied to the
workflow that uses it.

## Options

| Approach | Long-lived token | Human step per release | Provenance | Bootstraps a new package |
| --- | --- | --- | --- | --- |
| `NPM_TOKEN` secret + `npm publish` | yes | no | yes (`--provenance`) | **yes** |
| Trusted publishing (OIDC) + `npm publish` | no | no | yes (automatic) | no — needs the package to exist |
| Trusted publishing (OIDC, **stage-only**) + `npm stage publish` | no | **yes** — 2FA approval | yes | no — needs the package to exist |

## Staged publishing: evaluation

### What it is

`npm stage publish` submits the tarball to npm's staging area instead of the
public registry. A maintainer reviews it and approves with **2FA**, either in
the CLI or at npmjs.com → Packages → Staged Packages. Only then does the
version go live:

```bash
npm stage list                  # staged versions you can act on
npm stage view <stage-id>       # metadata
npm stage download <stage-id>   # fetch the tarball to inspect or test
npm stage approve <stage-id>    # publish it (prompts for 2FA)
npm stage reject <stage-id>     # discard it
```

`npm stage publish` itself needs no 2FA — the proof-of-presence is deferred to
approval, which is what makes it usable from CI.

### Why it fits this package

- **No long-lived token anywhere.** Combined with a trusted publisher
  configured with *stage-only* permission, CI can submit but **cannot** publish
  directly. A compromised workflow or runner yields nothing that can reach the
  public registry on its own.
- **The artifact is inspectable before it is public** — the staged tarball can
  be downloaded and diffed/tested, which is a stronger gate than reviewing the
  commit that produced it.
- **Provenance is retained.** npm still records a provenance attestation
  (npm CLI 11.15.0+, GitHub Actions), so `npm audit signatures` and the
  registry attestation bundle keep working.
- **It complements what CI already enforces** — runtime audit gate, required
  checks on `main`, Dependabot auto-merge for minor/patch — by adding the one
  thing automation cannot supply: a human 2FA approval on the release artifact.
  For a server that runs an autonomous agent inside people's workspaces, that
  is a proportionate amount of friction.
- **Our publish environment already satisfies it.** Verified from Node's
  release metadata: Node 24.21 (LTS) ships npm **11.19.0**, above the 11.15.0
  staging requirement. Node 22 ships npm 10.9.8, which satisfies neither
  staging nor trusted publishing — hence the Node 24 job.

### Constraints and costs

- **It cannot bootstrap a brand-new package.** npm requires the package to
  already exist on the registry, so `freebuff-mcp-server@0.3.0` — the first
  publish — must go out with a direct `npm publish` (token or interactive
  `npm login`). Staged publishing is a *second-release-onwards* improvement.
- **2FA must be enabled** on the publishing account. Staging does not need it;
  approving does. Without 2FA there is no approval path.
- **A manual approval per release.** Release automation becomes
  release → staged → approve. That is the intended trade, but it means a
  release is not live the moment the GitHub release is created.
- **The benefit depends on configuring the trusted publisher as stage-only.**
  If direct `npm publish` remains permitted for the same connection, a
  compromised workflow can still publish directly and the staging gate is
  bypassable.

## Decision

Adopt staged publishing as the **default release route once the package
exists**, keeping the direct route only for the bootstrap and for documented
break-glass use.

### Rollout

1. **Bootstrap** — publish `0.3.0` with a token (cannot be staged) and confirm
   it is live: `npm view freebuff-mcp-server version`.
2. **Enable 2FA** on the npm account if it is not already on.
3. **Configure the trusted publisher**: npmjs.com → the package → Settings →
   Trusted publishing → GitHub Actions, repository
   `RNK-Enterprise/freebuff-mcp-server`, workflow filename `publish.yml`, with
   **stage publish** allowed and direct `npm publish` **not** allowed.
4. **Release staged from then on**:
   ```bash
   git tag -a v0.3.2 -m "freebuff-mcp-server v0.3.2" && git push origin v0.3.2
   gh release create v0.3.2 --title v0.3.2 --notes-file .github/releases/v0.3.2.md
   gh workflow run publish.yml --ref v0.3.2 -f staging=true
   npm stage list && npm stage approve <stage-id>   # 2FA prompt
   ```
5. **Retire the token** — revoke the bootstrap token on npmjs.com and delete
   the `NPM_TOKEN` repository secret.

### Break glass

If a release must go out without an approval round trip, the direct route still
exists (`-f staging=false`), but it only works while a token or a non-stage-only
trusted publisher remains configured. Prefer republishing a fixed patch
version, approved normally, over loosening the gate.
