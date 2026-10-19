import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import * as StellarSdk from '@stellar/stellar-sdk'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envPath = path.join(root, '.env')
loadEnv({ path: envPath })

function saveEnv(name: string, value: string) {
  const source = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const line = `${name}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  const pattern = new RegExp(`^${name}=.*$`, 'm')
  const updated = pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`
  fs.writeFileSync(envPath, updated, { encoding: 'utf8', mode: 0o600 })
  process.env[name] = value
}

if ((process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase() !== 'TESTNET') {
  throw new Error('Refusing to deploy: VITE_STELLAR_NETWORK must be TESTNET')
}
const wasmPath = path.join(root, 'public/contracts/nftgram_marketplace.wasm')
if (!fs.existsSync(wasmPath)) throw new Error('Marketplace WASM is missing. Run npm run build:marketplace-contract first.')

let keypair: StellarSdk.Keypair
if (process.env.STELLAR_DEPLOYER_SECRET) keypair = StellarSdk.Keypair.fromSecret(process.env.STELLAR_DEPLOYER_SECRET)
else {
  keypair = StellarSdk.Keypair.random()
  saveEnv('STELLAR_DEPLOYER_SECRET', keypair.secret())
}

const publicKey = keypair.publicKey()
const rpc = new StellarSdk.rpc.Server(process.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org')
const horizon = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org')
try { await horizon.loadAccount(publicKey) }
catch {
  const funded = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`)
  if (!funded.ok) throw new Error('Friendbot could not fund the Testnet deployer wallet.')
  await horizon.loadAccount(publicKey)
}

async function submit(operation: StellarSdk.Operation): Promise<StellarSdk.rpc.Api.GetTransactionResponse> {
  const account = await rpc.getAccount(publicKey)
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.TESTNET })
    .addOperation(operation as never).setTimeout(300).build()
  const prepared = await rpc.prepareTransaction(tx)
  prepared.sign(keypair)
  const sent = await rpc.sendTransaction(prepared)
  if (sent.status === 'ERROR') throw new Error('Stellar Testnet rejected the marketplace deployment transaction.')
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const result = await rpc.getTransaction(sent.hash)
    if (result.status === 'SUCCESS') return result
    if (result.status === 'FAILED') throw new Error(`A Testnet transaction failed: ${sent.hash}`)
  }
  throw new Error('Timed out waiting for the Testnet deployment transaction.')
}

const wasm = new Uint8Array(fs.readFileSync(wasmPath))
const uploaded = await submit(StellarSdk.Operation.uploadContractWasm({ wasm }))
if (!uploaded.returnValue) throw new Error('WASM upload did not return a hash.')
const wasmHash = Uint8Array.from(StellarSdk.scValToNative(uploaded.returnValue as unknown as StellarSdk.xdr.ScVal) as Uint8Array)
const deployed = await submit(StellarSdk.Operation.createCustomContract({
  wasmHash,
  address: StellarSdk.Address.fromString(publicKey),
  salt: crypto.randomBytes(32),
  constructorArgs: [
    StellarSdk.nativeToScVal(publicKey, { type: 'address' }),
    StellarSdk.nativeToScVal(publicKey, { type: 'address' }),
    StellarSdk.nativeToScVal(250, { type: 'u32' }),
  ],
}))
if (!deployed.returnValue?.address) throw new Error('Contract deployment did not return an address.')
const marketplaceId = StellarSdk.scValToNative(deployed.returnValue as unknown as StellarSdk.xdr.ScVal)
if (typeof marketplaceId !== 'string' || !/^C[A-Z2-7]{55}$/.test(marketplaceId)) throw new Error('Deployment returned an invalid marketplace address.')

saveEnv('STELLAR_DEPLOYED_MARKETPLACE_CONTRACT_ID', marketplaceId)
saveEnv('STELLAR_MARKETPLACE_CONTRACT_ID', marketplaceId)
saveEnv('VITE_STELLAR_MARKETPLACE_CONTRACT_ID', marketplaceId)
console.log(`Marketplace deployed on Stellar Testnet: ${marketplaceId}`)
