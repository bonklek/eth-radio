#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import { readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'

const ffmpegExecutable = /** @type {string | null} */ (/** @type {unknown} */ (ffmpegPath))

if (helpRequested()) {
  console.log(`Usage:
  pnpm assets:overlays -- [--input <1920x1080.png>] [--out-dir <directory>]
`)
  process.exit(0)
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..')

function fromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value)
}

const source = fromRoot(readArg('input', 'public/rfe-assets/rfe-terminal-final.png'))
const outDir = fromRoot(readArg('out-dir', 'public/rfe-assets/overlays'))

// Keep this list in sync with the tracked overlay assets.
/** @type {Array<[string, number, number]>} */
const profiles = [
  ['360p', 640, 360],
  ['420p', 746, 420],
  ['480p', 854, 480],
  ['720p', 1280, 720],
  ['1080p', 1920, 1080],
]

if (!ffmpegExecutable) {
  throw new Error('ffmpeg-static did not provide an ffmpeg binary path')
}

if (!fs.existsSync(source)) {
  throw new Error(`Missing source overlay shell: ${path.relative(root, source)}`)
}

function readPngInfo(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 26) {
    throw new Error(`Overlay source PNG is truncated: ${path.relative(root, filePath)}`)
  }
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`Overlay source is not a PNG: ${path.relative(root, filePath)}`)
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer.readUInt8(24),
    colorType: buffer.readUInt8(25),
  }
}

function colorTypeHasAlpha(colorType) {
  return colorType === 4 || colorType === 6
}

const sourceInfo = readPngInfo(source)
if (sourceInfo.width !== 1920 || sourceInfo.height !== 1080) {
  throw new Error(
    `Expected source overlay to be 1920x1080, got ${sourceInfo.width}x${sourceInfo.height}: ${path.relative(root, source)}`,
  )
}

if (!colorTypeHasAlpha(sourceInfo.colorType)) {
  throw new Error(
    `Expected source overlay PNG to have an alpha channel, got color type ${sourceInfo.colorType}: ${path.relative(root, source)}`,
  )
}

fs.mkdirSync(outDir, { recursive: true })

for (const [name, width, height] of profiles) {
  const output = path.join(outDir, `rfe-terminal-${name}.png`)
  const sx = width / 1920
  const sy = height / 1080
  const box = ({ x, y, w, h }) =>
    `drawbox=x=${Math.round(x * sx)}:y=${Math.round(y * sy)}:w=${Math.round(w * sx)}:h=${Math.round(h * sy)}`
  const clearDynamicText = [
    `${box({ x: 112, y: 18, w: 1720, h: 82 })}:color=0x181a24@1:t=fill`,
    `${box({ x: 36, y: 916, w: 1848, h: 144 })}:color=0x11131a@1:t=fill`,
  ].join(',')
  const result = spawnSync(ffmpegExecutable, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    source,
    '-vf',
    `scale=${width}:${height}:flags=lanczos,format=rgba,${clearDynamicText}`,
    '-frames:v',
    '1',
    '-update',
    '1',
    output,
  ], { stdio: 'inherit' })

  if (result.status !== 0) {
    throw new Error(`ffmpeg failed while generating ${path.relative(root, output)}`)
  }

  const outputInfo = readPngInfo(output)
  if (outputInfo.width !== width || outputInfo.height !== height || !colorTypeHasAlpha(outputInfo.colorType)) {
    throw new Error(
      `Generated overlay failed validation: ${path.relative(root, output)} ` +
      `${outputInfo.width}x${outputInfo.height} colorType=${outputInfo.colorType}`,
    )
  }

  console.log(`${path.relative(root, output)} ${width}x${height}`)
}
