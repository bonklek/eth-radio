import fs from 'node:fs'
import path from 'node:path'
import { verifyStaticArtifactHtml } from './lib/static-artifact.mjs'
import { helpRequested } from './lib/cli-help.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm web:artifact -- [dist/decentralized/index.html]

Verifies the self-contained static artifact.
`)
  process.exit(0)
}

const root = process.cwd()
const artifactPath = path.resolve(root, process.argv[2] || path.join('dist', 'decentralized', 'index.html'))
if (!fs.existsSync(artifactPath)) throw new Error(`Static artifact not found: ${artifactPath}`)

const result = verifyStaticArtifactHtml(fs.readFileSync(artifactPath, 'utf8'), artifactPath)
console.log(`static artifact ok: ${artifactPath} (${result.bytes} bytes)`)
