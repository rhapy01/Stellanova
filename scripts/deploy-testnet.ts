import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import * as StellarSdk from '@stellar/stellar-sdk'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envPath = path.join(root, '.env')
loadEnv({ path: envPath })

function setEnvValue(name: string, value: string) {
  const source = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const line = `${name}="${escaped}"`
  const pattern = new RegExp(`^${name}=.*$`, 'm')
  const next = pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`
  fs.writeFileSync(envPath, next, { encoding: 'utf8', mode: 0o600 })
  process.env[name] = value
}

if ((process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase() !== 'TESTNET') {
  throw new Error('Refusing to deploy: VITE_STELLAR_NETWORK must be TESTNET')
}

const metadataBaseUri = process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL?.replace(/\/$/, '') + '/'
if (!metadataBaseUri || !/^https:\/\/.+\/$/.test(metadataBaseUri)) {
  throw new Error('CLOUDFLARE_R2_PUBLIC_BASE_URL must be a real HTTPS URL')
}
const paymentToken = process.env.VITE_STELLAR_PAYMENT_TOKEN ?? ''
if (!/^C[A-Z2-7]{55}$/.test(paymentToken)) throw new Error('VITE_STELLAR_PAYMENT_TOKEN must be a Stellar contract address')

let keypair: StellarSdk.Keypair
const configuredSecret = process.env.STELLAR_DEPLOYER_SECRET
if (configuredSecret) {
  keypair = StellarSdk.Keypair.fromSecret(configuredSecret)
} else {
  keypair = StellarSdk.Keypair.random()
  setEnvValue('STELLAR_DEPLOYER_SECRET', keypair.secret())
  console.log('Created a new Testnet deployer wallet and saved its secret in the gitignored .env file.')
}

const publicKey = keypair.publicKey()
const rpc = new StellarSdk.rpc.Server(process.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org')
const horizon = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org')
const networkPassphrase = StellarSdk.Networks.TESTNET

try {
  await horizon.loadAccount(publicKey)
  console.log('Testnet deployer account is already funded.')
} catch {
  console.log('Funding the Testnet deployer account with Friendbot…')
  const response = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`)
  if (!response.ok) throw new Error(`Friendbot could not fund the Testnet account (HTTP ${response.status})`)
  await horizon.loadAccount(publicKey)
}

async function sendPrepared(transaction: StellarSdk.Transaction): Promise<StellarSdk.rpc.Api.GetTransactionResponse> {
  transaction.sign(keypair)
  const sent = await rpc.sendTransaction(transaction)
  if (sent.status === 'ERROR') throw new Error('Stellar Testnet rejected a deployment transaction.')
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const result = await rpc.getTransaction(sent.hash)
    if (result.status === 'SUCCESS') return result
    if (result.status === 'FAILED') throw new Error(`A Testnet transaction failed: ${sent.hash}`)
  }
  throw new Error(`Timed out waiting for Testnet transaction ${sent.hash}`)
}

async function submit(operation: StellarSdk.Operation): Promise<StellarSdk.rpc.Api.GetTransactionResponse> {
  const account = await rpc.getAccount(publicKey)
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  }).addOperation(operation as never).setTimeout(300).build()
  return sendPrepared(await rpc.prepareTransaction(transaction))
}

async function invoke(contractId: string, method: string, args: StellarSdk.xdr.ScVal[]) {
  const account = await rpc.getAccount(publicKey)
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  }).addOperation(new StellarSdk.Contract(contractId).call(method, ...args) as never).setTimeout(300).build()
  const simulation = await rpc.simulateTransaction(transaction)
  if (StellarSdk.rpc.Api.isSimulationError(simulation)) throw new Error(`Unable to simulate ${method}: ${simulation.error}`)
  return sendPrepared(StellarSdk.rpc.assembleTransaction(transaction, simulation).build())
}

async function uploadAndDeploy(wasmPath: string, constructorArgs: StellarSdk.xdr.ScVal[]): Promise<string> {
  const wasm = new Uint8Array(fs.readFileSync(path.join(root, wasmPath)))
  const install = await submit(StellarSdk.Operation.uploadContractWasm({ wasm }))
  if (!install.returnValue) throw new Error('WASM upload did not return its hash.')
  const rawWasmHash = StellarSdk.scValToNative(install.returnValue as unknown as StellarSdk.xdr.ScVal)
  const wasmHash = Uint8Array.from(rawWasmHash as Uint8Array)
  if (wasmHash.length !== 32) throw new Error('WASM upload returned an invalid hash.')
  const deployed = await submit(StellarSdk.Operation.createCustomContract({
    wasmHash,
    address: StellarSdk.Address.fromString(publicKey),
    salt: crypto.randomBytes(32),
    constructorArgs,
  }))
  if (!deployed.returnValue?.address) throw new Error('Contract deployment did not return a contract address.')
  const contractId = StellarSdk.scValToNative(deployed.returnValue as unknown as StellarSdk.xdr.ScVal)
  if (typeof contractId !== 'string' || !/^C[A-Z2-7]{55}$/.test(contractId)) throw new Error('Contract deployment returned an invalid contract address.')
  return contractId
}

const scString = (value: string) => StellarSdk.nativeToScVal(value, { type: 'string' })
const scAddress = (value: string) => StellarSdk.nativeToScVal(value, { type: 'address' })

let nftContractId = process.env.STELLAR_DEPLOYED_NFT_CONTRACT_ID ?? ''
if (!/^C[A-Z2-7]{55}$/.test(nftContractId)) {
  console.log(`Deploying updated NFT contract from wallet ${publicKey}…`)
  nftContractId = await uploadAndDeploy('public/contracts/nftgram_nft.wasm', [scString(metadataBaseUri), scString('StellaNova Editions'), scString('STNV'), scAddress(publicKey)])
  setEnvValue('STELLAR_DEPLOYED_NFT_CONTRACT_ID', nftContractId)
} else {
  console.log(`Resuming setup for NFT contract ${nftContractId}…`)
}
await invoke(nftContractId, 'set_payment_token', [scAddress(paymentToken)])
console.log(`NFT contract deployed: ${nftContractId}`)

let marketplaceContractId = process.env.STELLAR_DEPLOYED_MARKETPLACE_CONTRACT_ID ?? ''
if (!/^C[A-Z2-7]{55}$/.test(marketplaceContractId)) {
  console.log('Deploying marketplace contract…')
  marketplaceContractId = await uploadAndDeploy('public/contracts/nftgram_marketplace.wasm', [scAddress(publicKey), scAddress(publicKey), StellarSdk.nativeToScVal(250, { type: 'u32' })])
  setEnvValue('STELLAR_DEPLOYED_MARKETPLACE_CONTRACT_ID', marketplaceContractId)
} else {
  console.log(`Resuming setup for marketplace contract ${marketplaceContractId}…`)
}
console.log(`Marketplace contract deployed: ${marketplaceContractId}`)

setEnvValue('VITE_STELLAR_NFT_CONTRACT_ID', nftContractId)
setEnvValue('VITE_STELLAR_MARKETPLACE_CONTRACT_ID', marketplaceContractId)
console.log('Saved both deployed Testnet contract IDs to .env. Restart the app server to load them.')
