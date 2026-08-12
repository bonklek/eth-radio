const HOST_ENV_KEYS = Object.freeze([
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'NODE_EXTRA_CA_CERTS',
])

function hostRuntimeEnv(source) {
  const output = {}
  for (const key of HOST_ENV_KEYS) {
    if (typeof source[key] === 'string' && source[key]) output[key] = source[key]
  }
  return output
}

export function mediaProcessEnv(source = process.env, { publisherAddress = '' } = {}) {
  return {
    ...hostRuntimeEnv(source),
    RFE_PROCESS_ROLE: 'media',
    ...(publisherAddress ? { RFE_PUBLISHER_ADDRESS: publisherAddress } : {}),
  }
}

export function publisherProcessEnv(source = process.env, { allowFaultInjection = false } = {}) {
  if (!source.PRIVATE_KEY) throw new Error('Publisher signer key is unavailable')
  return {
    ...hostRuntimeEnv(source),
    RFE_PROCESS_ROLE: 'publisher',
    PRIVATE_KEY: source.PRIVATE_KEY,
    ...(allowFaultInjection && source.PUBLISHER_FAULT_INJECT
      ? { PUBLISHER_FAULT_INJECT: source.PUBLISHER_FAULT_INJECT }
      : {}),
  }
}

export { HOST_ENV_KEYS }
