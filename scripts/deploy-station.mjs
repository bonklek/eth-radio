import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { assertRpcChain, chainFromEnv, requireMainnetConfirmation, requireSupportedChain } from './chains.mjs'
import { readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { acquireAccountLease } from './lib/account-lease.mjs'
import { installEndpointSafeProcessHandlers } from './lib/endpoint-privacy.mjs'
import {
  atomicWriteJson,
  assertTransactionExposureCeiling,
  maybeInjectPublisherFault,
  parseExposureCeilingEth,
  receiptCostWei,
  signedTransactionHash,
  transactionExposureWei,
} from './lib/publisher-safety.mjs'
import {
  assertStationDeploymentJournalIntent,
  makeStationDeploymentJournal,
  readStationDeploymentJournal,
  removeStationDeploymentJournal,
  stationDeploymentJournalPath,
  writeStationDeploymentJournal,
} from './lib/station-deployment-journal.mjs'
import { gasLimitEnv, optionalGweiEnv } from './lib/tx-env.mjs'

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm station:deploy -- [--max-exposure-eth <amount>] [--submission-journal <file>]

Environment:
  ETH_RPC_URL, PRIVATE_KEY, CHAIN=sepolia|mainnet
  Mainnet also requires MAINNET_CONFIRM and --max-exposure-eth.
`)
  process.exit(exitCode)
}

if (helpRequested()) usage(0)
dotenv.config({ quiet: true })
installEndpointSafeProcessHandlers(() => [process.env.ETH_RPC_URL].filter(Boolean))

const rpcUrl = process.env.ETH_RPC_URL
const privateKey = process.env.PRIVATE_KEY
const { chainName, chain } = chainFromEnv()
const maximumExposureEth = readArg('max-exposure-eth')
const hardExposureCeilingWei = maximumExposureEth === undefined
  ? null
  : parseExposureCeilingEth(maximumExposureEth, '--max-exposure-eth')

if (!rpcUrl || !privateKey) {
  console.error('Missing ETH_RPC_URL, PRIVATE_KEY, or supported CHAIN in .env')
  process.exit(1)
}
requireSupportedChain(chain)
requireMainnetConfirmation(chainName, 'deploy Station')

const account = privateKeyToAccount(/** @type {`0x${string}`} */ (privateKey))
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })
const { compileStation } = await import('./compile-station.mjs')
const { abi, bytecode } = compileStation()
const out = path.resolve(`work/blob-radio-testnet/contracts/Station.${chainName}.json`)
const journalPath = path.resolve(readArg('submission-journal', stationDeploymentJournalPath(chainName)))

await assertRpcChain(publicClient, chain)
const accountLease = acquireAccountLease({ chainId: chain.id, account: account.address })
try {
  console.log(`Deploying Station from ${account.address} on ${chain.name}...`)
  let journal = readStationDeploymentJournal(journalPath)
  let serializedTransaction
  let expectedHash
  let maximumExposureWei

  if (journal) {
    const recovered = await assertStationDeploymentJournalIntent(journal, {
      chain: chainName,
      chainId: chain.id,
      publisher: account.address,
      bytecode,
    })
    serializedTransaction = journal.serializedTransaction
    expectedHash = journal.txHash
    maximumExposureWei = recovered.exposureWei
  } else {
    if (fs.existsSync(out)) {
      throw new Error(`Station deployment metadata already exists at ${out}; refusing an accidental duplicate deployment`)
    }
    const maxFeePerGas = optionalGweiEnv('MAX_FEE_PER_GAS_GWEI')
    const maxPriorityFeePerGas = optionalGweiEnv('MAX_PRIORITY_FEE_PER_GAS_GWEI')
    const gas = gasLimitEnv()
    const request = /** @type {any} */ ({
      account,
      chain,
      type: /** @type {'eip1559'} */ ('eip1559'),
      data: /** @type {`0x${string}`} */ (bytecode),
      ...(maxFeePerGas !== undefined ? { maxFeePerGas } : {}),
      ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
      ...(gas !== undefined ? { gas } : {}),
    })
    const preparedTransaction = await walletClient.prepareTransactionRequest(request)
    maximumExposureWei = transactionExposureWei(preparedTransaction, 0)
    assertTransactionExposureCeiling({
      chainName,
      ceilingWei: hardExposureCeilingWei,
      exposureWei: maximumExposureWei,
      action: 'Station deploy',
    })
    serializedTransaction = await walletClient.signTransaction({ ...preparedTransaction, account, chain })
    expectedHash = signedTransactionHash(serializedTransaction)
    journal = makeStationDeploymentJournal({
      chain: chainName,
      chainId: chain.id,
      publisher: account.address,
      bytecode,
      serializedTransaction,
      reservedCostWei: maximumExposureWei,
      nonce: preparedTransaction.nonce,
    })
    writeStationDeploymentJournal(journalPath, journal)
    maybeInjectPublisherFault('deploy-after-prepared')
  }

  assertTransactionExposureCeiling({
    chainName,
    ceilingWei: hardExposureCeilingWei,
    exposureWei: maximumExposureWei,
    action: 'Station deploy',
  })

  if (journal.status !== 'confirmed') {
    try {
      const hash = await walletClient.sendRawTransaction({ serializedTransaction })
      if (hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error(`RPC returned unexpected transaction hash ${hash}`)
    } catch (error) {
      const knownReceipt = await publicClient.getTransactionReceipt({ hash: expectedHash }).catch(() => null)
      const knownTransaction = await publicClient.getTransaction({ hash: expectedHash }).catch(() => null)
      if (!knownReceipt && !knownTransaction) throw error
    }
    journal.status = 'broadcast'
    journal.broadcastAt ||= new Date().toISOString()
    writeStationDeploymentJournal(journalPath, journal)
    maybeInjectPublisherFault('deploy-after-broadcast')
  }
  console.log(`tx: ${expectedHash}`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash: expectedHash })
  if (receipt.status !== 'success') throw new Error(`Deployment transaction failed with status ${receipt.status}`)
  if (!receipt.contractAddress) throw new Error('Deployment receipt did not include a contract address')
  const costs = receiptCostWei(receipt, { expectedBlobCount: 0 })
  if (costs.totalWei > maximumExposureWei) throw new Error('Confirmed deployment cost exceeds reserved exposure')
  journal.status = 'confirmed'
  journal.contractAddress = receipt.contractAddress
  journal.actualCostWei = costs.totalWei.toString()
  journal.blockHash = receipt.blockHash
  journal.blockNumber = receipt.blockNumber.toString()
  journal.confirmedAt ||= new Date().toISOString()
  writeStationDeploymentJournal(journalPath, journal)
  maybeInjectPublisherFault('deploy-after-confirmation')

  const deployment = {
    app: 'eth-radio',
    contract: 'Station',
    chain: chainName,
    address: receipt.contractAddress,
    txHash: expectedHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    deployedAt: journal.confirmedAt,
    costWei: costs.totalWei.toString(),
    abi,
  }
  atomicWriteJson(out, deployment)
  maybeInjectPublisherFault('deploy-after-metadata')
  removeStationDeploymentJournal(journalPath)

  console.log(`address: ${receipt.contractAddress}`)
  console.log(`deployment: ${out}`)
} finally {
  accountLease.release()
}
