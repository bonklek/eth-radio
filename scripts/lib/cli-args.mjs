export function readArg(name, fallback = undefined, argv = process.argv) {
  const prefix = `--${name}=`
  const inline = argv.find((value) => value.startsWith(prefix))
  if (inline) {
    const value = inline.slice(prefix.length)
    if (!value) throw new Error(`--${name} requires a value`)
    return value
  }

  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback

  const value = argv[idx + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`)
  }
  return value
}

export function hasFlag(name, argv = process.argv) {
  return argv.includes(`--${name}`)
}

export function numberArg(name, fallback, { integer = false, min = undefined, max = undefined, argv = process.argv } = {}) {
  const value = readArg(name, fallback, argv)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${name}: ${value}`)
  if (integer && !Number.isInteger(parsed)) throw new Error(`Invalid --${name}: ${value}; expected an integer`)
  if (min !== undefined && parsed < min) throw new Error(`Invalid --${name}: ${value}; expected >= ${min}`)
  if (max !== undefined && parsed > max) throw new Error(`Invalid --${name}: ${value}; expected <= ${max}`)
  return parsed
}

export function bigintArg(name, fallback, { min = undefined, max = undefined, argv = process.argv } = {}) {
  const value = readArg(name, fallback, argv)
  let parsed
  try {
    parsed = BigInt(value)
  } catch {
    throw new Error(`Invalid --${name}: ${value}; expected an integer`)
  }
  if (min !== undefined && parsed < min) throw new Error(`Invalid --${name}: ${value}; expected >= ${min}`)
  if (max !== undefined && parsed > max) throw new Error(`Invalid --${name}: ${value}; expected <= ${max}`)
  return parsed
}
