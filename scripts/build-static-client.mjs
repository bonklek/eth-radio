import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sourceDir = path.join(root, 'public', 'decentralized')
const outDir = path.join(root, 'dist', 'decentralized')
const files = ['index.html', 'styles.css', 'app.js']

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

for (const file of files) {
  fs.copyFileSync(path.join(sourceDir, file), path.join(outDir, file))
}

const buildInfo = {
  app: 'eth-radio',
  target: 'decentralized-static-client',
  builtAt: new Date().toISOString(),
  files,
}

fs.writeFileSync(path.join(outDir, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`)
console.log(`static client built: ${outDir}`)
