#!/usr/bin/env node
/**
 * Fail when `npm audit --omit=dev` reports runtime-scope vulnerabilities.
 *
 * Guards against the class of regression where a transitive production
 * dependency (e.g. undici via @codebuff/sdk) picks up an advisory.
 *
 * Why this parses the JSON report instead of trusting npm's exit code:
 * `npm audit` exits 0 on findings in some npm versions, so a step that only
 * checks the exit status can pass a vulnerable tree.
 *
 * Env:
 *   AUDIT_MIN_SEVERITY  low|moderate|high|critical (default: low = any finding)
 *
 * A report that cannot be produced (registry or network problem) is a warning,
 * not a build failure, so transient npm registry issues don't redden CI.
 */
import { spawnSync } from 'node:child_process'

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']

const minSeverity = (process.env.AUDIT_MIN_SEVERITY ?? 'low').toLowerCase()
if (!SEVERITIES.includes(minSeverity)) {
  console.error(`::error::AUDIT_MIN_SEVERITY must be one of ${SEVERITIES.join(', ')} (got '${minSeverity}')`)
  process.exit(2)
}

const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
})

let report
try {
  report = JSON.parse(audit.stdout ?? '')
} catch {
  console.log('::warning::npm audit did not return a report (registry or network problem); not failing the build')
  process.exit(0)
}

const counts = report?.metadata?.vulnerabilities ?? {}
const threshold = SEVERITIES.indexOf(minSeverity)
const offending = SEVERITIES.slice(threshold).reduce((total, sev) => total + (counts[sev] ?? 0), 0)

if (offending === 0) {
  console.log(`npm audit: no runtime-scope vulnerabilities at or above '${minSeverity}'`)
  process.exit(0)
}

const advisories = Object.values(report.vulnerabilities ?? {})
  .filter((entry) => SEVERITIES.indexOf(entry.severity ?? 'low') >= threshold)
  .map((entry) => {
    const via = (entry.via ?? [])
      .map((source) => (typeof source === 'string' ? source : source.title))
      .filter(Boolean)
    return `  - ${entry.name} (${entry.severity}): ${via.join('; ') || 'see advisory'}`
  })

console.log(`npm audit: ${offending} runtime-scope vulnerabilities (${JSON.stringify(counts)})`)
if (advisories.length) console.log(advisories.join('\n'))
console.log(
  '::error::npm audit found runtime-scope vulnerabilities. Pin the affected dependency in the overrides block of package.json.',
)
process.exit(1)
