import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyStaticArtifactHtml } from './lib/static-artifact.mjs'

const root = process.cwd()
const artifactPath = path.join(root, 'dist', 'decentralized', 'index.html')
const builderSource = fs.readFileSync(path.join(root, 'scripts', 'build-static-client.mjs'), 'utf8')
for (const guard of ['may only import earlier allowlisted modules', 'contains an unsupported module import', 'contains an unsupported export form', 'contains an unsupported runtime import']) {
  if (!builderSource.includes(guard)) throw new Error(`Static builder is missing module-graph guard: ${guard}`)
}
const build = spawnSync(process.execPath, ['scripts/build-static-client.mjs'], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) throw new Error(`Static build failed with exit code ${build.status}`)

const html = fs.readFileSync(artifactPath, 'utf8')
const bundledApp = fs.readFileSync(path.join(root, 'dist', 'decentralized', 'app.js'), 'utf8')
verifyStaticArtifactHtml(html, 'fresh build')
if (!html.includes('function canonicalStreamIdHash(') || !html.includes('function classifyPlaybackMode(') || !html.includes('function readBoundedResponseBytes(')) {
  throw new Error('Fresh artifact is missing a flattened static client module')
}
if (html.includes("from './static-client-core.js'")
  || html.includes("from './static-client-io.js'")
  || html.includes("from '../../packages/protocol/browser-kernel.js'")) {
  throw new Error('Fresh artifact retained a runtime module import')
}
if (/^import\s/m.test(bundledApp) || /^export\s/m.test(bundledApp)) {
  throw new Error('Fresh artifact app.js retained an unresolved module boundary')
}
if (!html.includes('If this message remains, the chain viewer did not finish loading.')
  || !html.includes('Chain playback and verification are unavailable until JavaScript is enabled')) {
  throw new Error('Fresh artifact is missing durable degraded-startup guidance')
}
if (!bundledApp.includes('markStartupReady()')) throw new Error('Fresh artifact cannot unlock the inert application shell')

function expectRejected(name, mutated, expectedError = null) {
  try {
    verifyStaticArtifactHtml(mutated, name)
  } catch (error) {
    if (expectedError && !expectedError.test(String(error?.message || error))) {
      throw new Error(`${name} was rejected for the wrong reason: ${error?.message || error}`, { cause: error })
    }
    return
  }
  throw new Error(`${name} unexpectedly passed artifact verification`)
}

expectRejected('corrupted bundled script', html.replace('const SENSITIVE_URL_PARAMS', 'const TAMPERED_URL_PARAMS'))
expectRejected('weakened CSP', html.replace("script-src 'sha256-", "script-src 'unsafe-inline' 'sha256-"))
expectRejected('external script residue', html.replace('<script type="module">', '<script type="module" src="./app.js">'))

const bundledScript = html.match(/<script\s+type="module">([\s\S]*?)<\/script>/)?.[1]
if (!bundledScript) throw new Error('Fresh artifact has no bundled script for syntax regression testing')
const duplicateDeclarationScript = `${bundledScript}\nconst artifactSyntaxCollision = 1\nconst artifactSyntaxCollision = 2\n`
const sourceHash = (source) => `'sha256-${crypto.createHash('sha256').update(source.replace(/\r\n?/g, '\n')).digest('base64')}'`
const duplicateDeclarationArtifact = html
  .replace(bundledScript, () => duplicateDeclarationScript)
  .replace(sourceHash(bundledScript), sourceHash(duplicateDeclarationScript))
expectRejected('duplicate declaration bundle', duplicateDeclarationArtifact, /bundled JavaScript does not parse/)

console.log('static artifact negative tests ok')
