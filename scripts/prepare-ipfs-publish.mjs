import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const outDir = path.join(root, 'dist', 'decentralized')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`)
  }
  return result.stdout?.trim() || ''
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return result.status === 0
}

function ipfsAddRootCid(output) {
  const cids = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!cids.length) throw new Error('ipfs add did not print a CID')
  return cids.at(-1)
}

run(process.execPath, ['scripts/build-static-client.mjs'])
run(process.execPath, ['scripts/verify-static-client.mjs'])

if (!fs.existsSync(path.join(outDir, 'index.html'))) {
  throw new Error(`Missing static build output: ${outDir}`)
}

console.log(`\nStatic client is ready at ${outDir}`)

if (!commandExists('ipfs')) {
  console.log(`
IPFS CLI was not found, so no CID was calculated.

Install an IPFS implementation, then run:

  ipfs add --recursive --cid-version=1 --only-hash --quiet dist/decentralized

When you are ready to publish/pin for real:

  ipfs add --recursive --cid-version=1 --quiet dist/decentralized
`)
  process.exit(0)
}

const cid = ipfsAddRootCid(run('ipfs', ['add', '--recursive', '--cid-version=1', '--only-hash', '--quiet', outDir], { capture: true }))
console.log(`
Dry-run IPFS CID:

  ${cid}

DNSLink TXT record for a subdomain:

  _dnslink.<subdomain> TXT "dnslink=/ipfs/${cid}"

Publish/pin when the frontend is ready:

  ipfs add --recursive --cid-version=1 --quiet dist/decentralized
`)
