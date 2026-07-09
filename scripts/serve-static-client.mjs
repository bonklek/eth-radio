import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'

const root = process.cwd()

const port = numberArg('port', process.env.PORT || '8080', { integer: true, min: 1, max: 65535 })
const host = readArg('host', process.env.HOST || '127.0.0.1')
const source = readArg('source', hasFlag('dist') ? 'dist' : 'public')
if (source !== 'public' && source !== 'dist') throw new Error(`Invalid --source: ${source}. Choose public or dist.`)

if (hasFlag('build')) {
  const result = spawnSync(process.execPath, ['scripts/build-static-client.mjs'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status || 1)
}

const staticDir = source === 'dist'
  ? path.join(root, 'dist', 'decentralized')
  : path.join(root, 'public', 'decentralized')
const badRequest = Symbol('badRequest')
let staticRoot = ''

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webm', 'video/webm'],
  ['.mp4', 'video/mp4'],
])

const defaultHeaders = {
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...defaultHeaders,
    ...headers,
  })
  response.end(body)
}

function isInsideStaticRoot(filePath) {
  const rootWithSep = staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`
  return filePath === staticRoot || filePath.startsWith(rootWithSep)
}

function canonicalStaticFile(filePath) {
  if (!fs.existsSync(filePath)) return filePath
  const realPath = fs.realpathSync(filePath)
  return isInsideStaticRoot(realPath) ? realPath : null
}

function resolveRequest(url) {
  let pathname
  try {
    const parsed = new URL(url, `http://${host}:${port}`)
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return badRequest
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(staticDir, relative)
  const rootWithSep = staticDir.endsWith(path.sep) ? staticDir : `${staticDir}${path.sep}`
  if (resolved !== staticDir && !resolved.startsWith(rootWithSep)) return null
  const filePath = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? path.join(resolved, 'index.html')
    : resolved
  return canonicalStaticFile(filePath)
}

if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
  console.error(`Static client not found at ${staticDir}`)
  console.error('Run with --build or run pnpm web:build first when serving dist.')
  process.exit(1)
}
staticRoot = fs.realpathSync(staticDir)

const server = http.createServer((request, response) => {
  const file = resolveRequest(request.url || '/')
  if (file === badRequest) {
    send(response, 400, 'Bad request\n', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }
  if (!file || !fs.existsSync(file)) {
    send(response, 404, 'Not found\n', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }

  const ext = path.extname(file).toLowerCase()
  send(response, 200, fs.readFileSync(file), {
    'content-type': contentTypes.get(ext) || 'application/octet-stream',
  })
})

server.listen(port, host, () => {
  console.log(`static watcher: http://${host}:${port}/`)
  console.log(`serving: ${staticDir}`)
})
