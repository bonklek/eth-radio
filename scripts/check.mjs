import { spawnSync } from 'node:child_process'
import { helpRequested } from './lib/cli-help.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm check

Runs the complete local and CI verification gate, including builds, tests, and dependency audit.
`)
  process.exit(0)
}

const root = process.cwd()
const checks = [
  ['syntax', ['scripts/check-syntax.mjs']],
  ['text hygiene', ['scripts/check-text.mjs']],
  ['configuration formatting', ['node_modules/prettier/bin/prettier.cjs', '--check', 'package.json', 'pnpm-workspace.yaml', '.github/**/*.{yml,yaml}']],
  ['library typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.check.json']],
  ['lint', ['node_modules/eslint/bin/eslint.js', '.']],
  ['Station compile', ['scripts/compile-station.mjs']],
  ['Station Cancun EVM behavior', ['scripts/test-station-evm.mjs']],
  ['shared protocol kernel', ['scripts/test-protocol-kernel.mjs']],
  ['shared availability profile', ['scripts/test-protocol-availability.mjs']],
  ['deterministic playback decision', ['scripts/test-protocol-playback.mjs']],
  ['station constitution schema', ['scripts/test-protocol-constitution.mjs']],
  ['fee history and estimate snapshots', ['scripts/test-economics-fees.mjs']],
  ['static build', ['scripts/build-static-client.mjs']],
  ['static source verification', ['scripts/verify-static-client.mjs']],
  ['static artifact verification', ['scripts/verify-static-artifact.mjs']],
  ['static artifact negative tests', ['scripts/test-static-artifact.mjs']],
  ['static artifact production smoke', ['scripts/test-static-artifact-production.mjs']],
  ['static-client logic', ['scripts/test-static-client-ui-logic.mjs']],
  ['static-client production smoke', ['scripts/test-static-client-production.mjs']],
  ['static-client storage denied', ['scripts/test-static-client-storage-denied.mjs']],
  ['publisher dry runs', ['scripts/test-publisher-dry-run.mjs']],
  ['publisher manifest selection', ['scripts/test-publisher-manifest.mjs']],
  ['publisher state bounds and migration', ['scripts/test-publisher-state-bounds.mjs']],
  ['publisher crash and exposure safety', ['scripts/test-publisher-safety.mjs']],
  ['filesystem identity and migration', ['scripts/test-filesystem-identity.mjs']],
  ['local manifest parsed index', ['scripts/test-local-manifest-index.mjs']],
  ['runtime filesystem bounds', ['scripts/test-runtime-filesystem-bounds.mjs']],
  ['segment input pipeline', ['scripts/test-segment-input.mjs']],
  ['live-run filesystem identity', ['scripts/test-run-live-station-stream-id.mjs']],
  ['live segment CLI', ['scripts/test-live-segment-cli.mjs']],
  ['utility CLI guards', ['scripts/test-utility-cli-guards.mjs']],
  ['CLI correctness', ['scripts/test-cli-correctness.mjs']],
  ['CLI help safety', ['scripts/test-cli-help-safety.mjs']],
  ['operator tooling', ['scripts/test-operator-tooling.mjs']],
  ['operator endpoint privacy', ['scripts/test-operator-endpoint-privacy.mjs']],
  ['Station history incremental scan', ['scripts/test-station-history.mjs']],
  ['security boundaries', ['scripts/test-security-boundaries.mjs']],
  ['security remediation boundaries', ['scripts/test-security-remediation.mjs']],
  ['live demo integrity', ['scripts/test-live-demo-integrity.mjs']],
  ['live demo pages', ['scripts/test-live-demo-pages.mjs']],
]

function run(command, args, label) {
  console.log(`\n[check] ${label}`)
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

for (const [label, args] of checks) run(process.execPath, args, label)

const pnpmScript = process.env.npm_execpath
if (!pnpmScript) throw new Error('Run the aggregate check through pnpm so the dependency audit uses the pinned package manager.')
run(process.execPath, [pnpmScript, 'audit', '--audit-level', 'high'], 'dependency audit')

console.log('\nall checks passed')
