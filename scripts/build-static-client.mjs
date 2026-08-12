import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { helpRequested } from './lib/cli-help.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm web:build

Builds public/decentralized into the deterministic dist/decentralized artifact.
`)
  process.exit(0)
}

const root = process.cwd()
const sourceDir = path.join(root, 'public', 'decentralized')
const outDir = path.join(root, 'dist', 'decentralized')
const moduleFiles = ['static-client-limits.js', 'static-client-core.js', 'static-client-io.js', 'static-client-media.js']
const sharedModuleSpecifiers = ['../../packages/protocol/browser-kernel.js']
const files = ['index.html', 'docs.html', 'viewer-recovery.html', 'publisher-safety.html', 'protocol-model.html', 'station-operations.html', 'scenarios.html', 'glossary-status.html', 'developer-guide.html', 'docs.js', 'styles.css', ...moduleFiles, 'app.js']
const moduleSources = [
  ...sharedModuleSpecifiers.map((specifier) => ({
    specifier,
    label: specifier,
    path: path.resolve(sourceDir, specifier),
  })),
  ...moduleFiles.map((file) => ({
    specifier: `./${file}`,
    label: file,
    path: path.join(sourceDir, file),
  })),
]

function escapeRawTextElementContent(value, tagName) {
  return String(value).replace(new RegExp(`</${tagName}`, 'gi'), `<\\/${tagName}`)
}

function cspHash(value) {
  const browserText = String(value).replace(/\r\n?/g, '\n')
  return `'sha256-${crypto.createHash('sha256').update(browserText).digest('base64')}'`
}

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

for (const file of files) {
  fs.copyFileSync(path.join(sourceDir, file), path.join(outDir, file))
}

const htmlPath = path.join(outDir, 'index.html')
const css = fs.readFileSync(path.join(sourceDir, 'styles.css'), 'utf8')
const app = fs.readFileSync(path.join(sourceDir, 'app.js'), 'utf8')
let html = fs.readFileSync(htmlPath, 'utf8')
const inlineCss = escapeRawTextElementContent(css, 'style')
const moduleImportPattern = /^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\r?\n/gm

function namedImports(source) {
  return [...source.matchAll(moduleImportPattern)].flatMap((match) => match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [imported, local = imported] = entry.split(/\s+as\s+/)
      if (!/^[$A-Z_a-z][$\w]*$/.test(imported) || !/^[$A-Z_a-z][$\w]*$/.test(local)) {
        throw new Error(`Static client contains an unsupported named import: ${entry}`)
      }
      return { imported, local, specifier: match[2] }
    }))
}

const importedModules = [...new Set(namedImports(app).map(({ specifier }) => specifier))]
const allowedModuleSpecifiers = moduleSources.map(({ specifier }) => specifier)
if (importedModules.length !== allowedModuleSpecifiers.length
  || allowedModuleSpecifiers.some((specifier) => !importedModules.includes(specifier))
  || new Set(importedModules).size !== importedModules.length) {
  throw new Error(`Static client imports must match the build module allowlist: ${allowedModuleSpecifiers.join(', ')}`)
}
const moduleSourceTexts = moduleSources.map((moduleSource) => fs.readFileSync(moduleSource.path, 'utf8'))
const allConsumerSources = [...moduleSourceTexts, app]
const bundledModules = moduleSources.map((moduleSource, moduleIndex) => {
  const source = moduleSourceTexts[moduleIndex]
  const dependencyImports = namedImports(source)
  const priorSpecifiers = new Set(moduleSources.slice(0, moduleIndex).map(({ specifier }) => specifier))
  if (dependencyImports.some(({ specifier }) => !priorSpecifiers.has(specifier))) throw new Error(`${moduleSource.label} may only import earlier allowlisted modules`)
  const sourceWithoutImports = source.replace(moduleImportPattern, '')
  if (/^import\s/m.test(sourceWithoutImports)) throw new Error(`${moduleSource.label} contains an unsupported module import`)
  const unsupportedExport = sourceWithoutImports.split(/\r?\n/).find((line) => /^export\s/.test(line) && !/^export (?:async )?function\s/.test(line))
  if (unsupportedExport) throw new Error(`${moduleSource.label} contains an unsupported export form`)
  const flattened = sourceWithoutImports.replace(/^export\s+(?=(?:async )?function\s)/gm, '')
  if (/^export\s/m.test(flattened)) throw new Error(`${moduleSource.label} could not be flattened safely`)
  const exportedNames = [...sourceWithoutImports.matchAll(/^export\s+(?:async\s+)?function\s+([$A-Z_a-z][$\w]*)/gm)]
    .map((match) => match[1])
  const bindings = allConsumerSources.slice(moduleIndex + 1)
    .flatMap((consumerSource) => namedImports(consumerSource))
    .filter(({ specifier }) => specifier === moduleSource.specifier)
  const uniqueBindings = [...new Map(bindings.map((binding) => [`${binding.imported}:${binding.local}`, binding])).values()]
  for (const { imported } of uniqueBindings) {
    if (!exportedNames.includes(imported)) throw new Error(`${moduleSource.label} does not export imported binding ${imported}`)
  }
  if (uniqueBindings.length === 0) return `(() => {\n${flattened}\n})()`
  const bindingPattern = uniqueBindings
    .map(({ imported, local }) => imported === local ? imported : `${imported}: ${local}`)
    .join(', ')
  return `const { ${bindingPattern} } = (() => {\n${flattened}\nreturn { ${exportedNames.join(', ')} }\n})()`
})
const appWithoutLocalImports = app.replace(moduleImportPattern, '')
if (/^import\s/m.test(appWithoutLocalImports)) throw new Error('Static client contains an unsupported runtime import')
const bundledApp = `${bundledModules.join('\n')}\n${appWithoutLocalImports}`
fs.writeFileSync(path.join(outDir, 'app.js'), bundledApp)
const inlineApp = escapeRawTextElementContent(bundledApp, 'script')
const styleHash = cspHash(inlineCss)
const scriptHash = cspHash(inlineApp)
html = html
  .replace("style-src 'self'", `style-src ${styleHash}`)
  .replace("script-src 'self'", `script-src ${scriptHash}`)
  .replace(/<link rel="stylesheet" href="\.\/styles\.css" \/>\r?\n?/, () => `<style>${inlineCss}</style>\n`)
  .replace(/<script type="module" src="\.\/app\.js"><\/script>/, () => `<script type="module">${inlineApp}</script>`)
fs.writeFileSync(htmlPath, html)

const buildInfo = {
  app: 'eth-radio',
  target: 'decentralized-static-client',
  files,
  sharedModules: sharedModuleSpecifiers,
  entrypoint: 'index.html',
  bundled: true,
  reproducible: true,
  contentSecurityPolicy: 'sha256',
}

fs.writeFileSync(path.join(outDir, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`)
console.log(`static client built: ${outDir}`)
