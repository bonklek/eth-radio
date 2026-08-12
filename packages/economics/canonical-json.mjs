import { createHash } from 'node:crypto'
import { boundedText, record } from '../protocol/scalars.mjs'

export const MAX_CANONICAL_JSON_DEPTH = 16
export const MAX_CANONICAL_JSON_COLLECTION_ENTRIES = 64
export const MAX_CANONICAL_JSON_STRING_BYTES = 16_384
export const MAX_CANONICAL_JSON_BYTES = 1_048_576

function assertUnicodeScalarString(value, label) {
  boundedText(value, label, { maxBytes: MAX_CANONICAL_JSON_STRING_BYTES, allowEmpty: true })
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} must not contain an unpaired UTF-16 surrogate`)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} must not contain an unpaired UTF-16 surrogate`)
    }
  }
  return value
}

function assertDenseClosedArray(value, label) {
  if (value.length > MAX_CANONICAL_JSON_COLLECTION_ENTRIES) {
    throw new RangeError(`${label} must contain at most ${MAX_CANONICAL_JSON_COLLECTION_ENTRIES} entries`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${label} must not contain non-index own properties`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}[${key}] must be an enumerable data property`)
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must not contain sparse entries`)
  }
}

function addCanonicalBytes(current, added, label) {
  const total = current + added
  if (total > MAX_CANONICAL_JSON_BYTES) {
    throw new RangeError(`${label} exceeds maximum canonical byte length ${MAX_CANONICAL_JSON_BYTES}`)
  }
  return total
}

function serializedScalarBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function normalizeCanonicalJsonNode(input, label, depth) {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new RangeError(`${label} exceeds maximum depth ${MAX_CANONICAL_JSON_DEPTH}`)
  }
  if (typeof input === 'string') {
    const value = assertUnicodeScalarString(input, label)
    return { value, bytes: serializedScalarBytes(value) }
  }
  if (typeof input === 'boolean') {
    return { value: input, bytes: input ? 4 : 5 }
  }
  if (Array.isArray(input)) {
    assertDenseClosedArray(input, label)
    const normalized = []
    let bytes = 2
    for (let index = 0; index < input.length; index += 1) {
      if (index > 0) bytes = addCanonicalBytes(bytes, 1, label)
      const child = normalizeCanonicalJsonNode(input[index], `${label}[${index}]`, depth + 1)
      bytes = addCanonicalBytes(bytes, child.bytes, label)
      normalized.push(child.value)
    }
    return { value: Object.freeze(normalized), bytes }
  }
  if (input === null || typeof input !== 'object') {
    throw new TypeError(`${label} must contain only strings, booleans, arrays, or objects`)
  }
  const value = record(input, label)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`)
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length > MAX_CANONICAL_JSON_COLLECTION_ENTRIES) {
    throw new RangeError(`${label} must contain at most ${MAX_CANONICAL_JSON_COLLECTION_ENTRIES} fields`)
  }
  const normalized = Object.create(null)
  let bytes = 2
  let fieldIndex = 0
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol keys`)
    assertUnicodeScalarString(key, `${label} field name`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`)
    }
    if (fieldIndex > 0) bytes = addCanonicalBytes(bytes, 1, label)
    bytes = addCanonicalBytes(bytes, serializedScalarBytes(key) + 1, label)
    const child = normalizeCanonicalJsonNode(descriptor.value, `${label}.${key}`, depth + 1)
    bytes = addCanonicalBytes(bytes, child.bytes, label)
    normalized[key] = child.value
    fieldIndex += 1
  }
  return { value: Object.freeze(normalized), bytes }
}

export function normalizeCanonicalJsonValue(input, label = 'canonical JSON value') {
  return normalizeCanonicalJsonNode(input, label, 0).value
}

function serializeNormalized(value) {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(serializeNormalized).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeNormalized(value[key])}`).join(',')}}`
}

export function canonicalizeJson(input, label = 'canonical JSON document') {
  const normalized = normalizeCanonicalJsonValue(input, label)
  const serialized = serializeNormalized(normalized)
  return serialized
}

export function sha256DomainSeparatedCanonicalJson(domain, input, label = 'canonical JSON document') {
  const domainText = assertUnicodeScalarString(domain, 'canonical JSON digest domain')
  const canonical = canonicalizeJson(input, label)
  const digest = createHash('sha256')
    .update(Buffer.from(`${domainText}\0`, 'utf8'))
    .update(Buffer.from(canonical, 'utf8'))
    .digest('hex')
  return Object.freeze({
    canonical,
    digest: `0x${digest}`,
  })
}
