import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import solc from 'solc'

export function compileStation() {
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

  const output = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = output.errors || []
  const fatal = errors.filter((error) => error.severity === 'error')
  for (const error of errors) {
    const writer = error.severity === 'error' ? console.error : console.warn
    writer(error.formattedMessage || error.message)
  }
  if (fatal.length) throw new Error('Station.sol compilation failed')

  const contract = output.contracts['Station.sol'].Station
  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
