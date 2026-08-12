import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import {
  HttpFileError,
  openValidatedStaticFile,
  sendHttpFileError,
  serveOpenedFile,
} from './lib/http-file-serving.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm web:serve -- [--host 127.0.0.1] [--port 8080] [--source public|dist]
                     [--dist] [--build]
`)
  process.exit(0)
}

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
  return resolved
}

if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
  console.error(`Static client not found at ${staticDir}`)
  console.error('Run with --build or run pnpm web:build first when serving dist.')
  process.exit(1)
}
staticRoot = fs.realpathSync(staticDir)

async function openRequestFile(filePath) {
  try {
    return await openValidatedStaticFile(staticRoot, filePath)
  } catch (error) {
    if (!(error instanceof HttpFileError) || error.status !== 404) throw error
    return openValidatedStaticFile(staticRoot, path.join(filePath, 'index.html'))
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method not allowed\n', {
      allow: 'GET, HEAD',
      'content-type': 'text/plain; charset=utf-8',
    })
    return
  }
  const file = resolveRequest(request.url || '/')
  if (file === badRequest) {
    send(response, 400, 'Bad request\n', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }
  if (!file) {
    send(response, 404, 'Not found\n', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }
  try {
    const opened = await openRequestFile(file)
    const ext = path.extname(opened.canonicalPath).toLowerCase()
    await serveOpenedFile(request, response, opened, {
      contentType: contentTypes.get(ext) || 'application/octet-stream',
      headers: defaultHeaders,
    })
  } catch (error) {
    sendHttpFileError(response, error, defaultHeaders)
  }
})

server.listen(port, host, () => {
  console.log(`static watcher: http://${host}:${port}/`)
  console.log(`serving: ${staticDir}`)
})
