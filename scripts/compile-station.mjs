import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { helpRequested } from './lib/cli-help.mjs'

const require = createRequire(import.meta.url)

function assertSolcObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid solc output: ${label} must be an object`)
  }
  return value
}

function solcDiagnostics(output) {
  if (output.errors === undefined) return []
  if (!Array.isArray(output.errors)) {
    throw new Error('Invalid solc output: errors must be an array')
  }
  return output.errors
}

function stationContract(output) {
  const contracts = assertSolcObject(output.contracts, 'contracts')
  const stationSource = assertSolcObject(contracts['Station.sol'], 'contracts["Station.sol"]')
  const contract = assertSolcObject(stationSource.Station, 'contracts["Station.sol"].Station')
  if (!Array.isArray(contract.abi)) {
    throw new Error('Invalid solc output: Station ABI must be an array')
  }
  const bytecode = contract.evm?.bytecode?.object
  if (typeof bytecode !== 'string' || !/^[0-9a-fA-F]+$/.test(bytecode)) {
    throw new Error('Invalid solc output: Station bytecode must be hex')
  }
  return contract
}

export function compileStation() {
  const solc = /** @type {typeof import('solc')} */ (require('solc'))
  const contractPath = path.resolve('contracts/Station.sol')
  const source = fs.readFileSync(contractPath, 'utf8')
  const input = {
    language: 'Solidity',
    sources: {
      'Station.sol': { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  }

  const output = assertSolcObject(JSON.parse(solc.compile(JSON.stringify(input))), 'root')
  const errors = solcDiagnostics(output)
  const fatal = errors.filter((error) => error.severity === 'error')
  for (const error of errors) {
    const writer = error.severity === 'error' ? console.error : console.warn
    writer(error.formattedMessage || error.message)
  }
  if (fatal.length) throw new Error('Station.sol compilation failed')

  const contract = stationContract(output)
  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (helpRequested()) {
    console.log(`Usage:
  pnpm station:compile

Compiles contracts/Station.sol and writes ABI/bytecode under work/blob-radio-testnet/contracts.
`)
  } else {
    const { abi, bytecode } = compileStation()
    fs.mkdirSync('work/blob-radio-testnet/contracts', { recursive: true })
    fs.writeFileSync(
      'work/blob-radio-testnet/contracts/Station.abi.json',
      `${JSON.stringify(abi, null, 2)}\n`,
    )
    fs.writeFileSync('work/blob-radio-testnet/contracts/Station.bytecode.txt', `${bytecode}\n`)
    console.log(`abi entries: ${abi.length}`)
    console.log(`bytecode bytes: ${(bytecode.length - 2) / 2}`)
  }
}
