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

const htmlPath = path.join(outDir, 'index.html')
const css = fs.readFileSync(path.join(sourceDir, 'styles.css'), 'utf8')
const app = fs.readFileSync(path.join(sourceDir, 'app.js'), 'utf8')
let html = fs.readFileSync(htmlPath, 'utf8')
html = html
  .replace(/<link rel="stylesheet" href="\.\/styles\.css" \/>\r?\n?/, `<style>\n${css}\n</style>\n`)
  .replace(/<script type="module" src="\.\/app\.js"><\/script>/, `<script type="module">\n${app}\n</script>`)
fs.writeFileSync(htmlPath, html)

const buildInfo = {
  app: 'eth-radio',
  target: 'decentralized-static-client',
  builtAt: new Date().toISOString(),
  files,
  entrypoint: 'index.html',
  bundled: true,
}

fs.writeFileSync(path.join(outDir, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`)
console.log(`static client built: ${outDir}`)
