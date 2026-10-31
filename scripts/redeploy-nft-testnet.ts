import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import * as StellarSdk from '@stellar/stellar-sdk'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envPath = path.join(root, '.env')
loadEnv({ path: envPath })
const slug = process.argv[2]
if (!slug) throw new Error('Usage: tsx scripts/redeploy-nft-testnet.ts <collection-slug>')
if ((process.env.VITE_STELLAR_NETWORK ?? '').toUpperCase() !== 'TESTNET') throw new Error('Refusing to deploy unless VITE_STELLAR_NETWORK=TESTNET')
const secret = process.env.STELLAR_DEPLOYER_SECRET
if (!secret) throw new Error('STELLAR_DEPLOYER_SECRET is required; refusing to generate a different deployer key.')
const oldContract = process.env.STELLAR_DEPLOYED_NFT_CONTRACT_ID ?? process.env.VITE_STELLAR_NFT_CONTRACT_ID ?? ''
if (!/^C[A-Z2-7]{55}$/.test(oldContract)) throw new Error('Could not determine the existing NFT contract ID.')
const paymentToken = process.env.VITE_STELLAR_PAYMENT_TOKEN ?? ''
if (!/^C[A-Z2-7]{55}$/.test(paymentToken)) throw new Error('VITE_STELLAR_PAYMENT_TOKEN must be a Stellar contract address.')
const baseUri = (process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL ?? '').replace(/\/$/, '') + '/'
if (!/^https:\/\/.+\/$/.test(baseUri)) throw new Error('CLOUDFLARE_R2_PUBLIC_BASE_URL must be a public HTTPS URL.')
const wasmPath = path.join(root, 'public/contracts/nftgram_nft.wasm')
if (!fs.existsSync(wasmPath)) throw new Error('NFT contract WASM is missing. Run npm run build:nft-contract.')
const keypair = StellarSdk.Keypair.fromSecret(secret)
const deployer = keypair.publicKey()
const rpc = new StellarSdk.rpc.Server(process.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org')
const { query, withTransaction, closeDatabase } = await import('../server/db.ts')

const rows = await query<any[]>(`SELECT id, slug, owner_wallet, contract_id FROM collections WHERE slug = ?`, [slug])
if (rows.length !== 1) throw new Error(`Expected exactly one collection named ${slug}; found ${rows.length}.`)
const collection = rows[0]
if (collection.contract_id !== oldContract) throw new Error(`Collection contract changed since preflight (expected ${oldContract}, found ${collection.contract_id}).`)
const counts = await query<any[]>(`SELECT
  (SELECT COUNT(*)::int FROM nft_mints WHERE collection_id = ?) AS mints,
  (SELECT COUNT(*)::int FROM token_collections WHERE collection_id = ?) AS indexed_tokens,
  (SELECT COUNT(*)::int FROM mint_stages WHERE collection_id = ? AND is_published = TRUE) AS published_stages`, [slug, slug, slug])
if (Number(counts[0]?.mints ?? 0) || Number(counts[0]?.indexed_tokens ?? 0) || Number(counts[0]?.published_stages ?? 0)) {
  throw new Error(`Refusing contract switch: collection has ${counts[0].mints} DB mints, ${counts[0].indexed_tokens} indexed tokens, and ${counts[0].published_stages} published stages.`)
}
console.log(`Preflight passed for ${slug}: owner ${collection.owner_wallet}; 0 recorded mints; current contract ${oldContract}.`)

const pageSize = 100
const onChainIds: number[] = []
for (let start = 0; ; start += pageSize) {
  const account = await rpc.getAccount(deployer)
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.TESTNET })
    .addOperation(new StellarSdk.Contract(oldContract).call('collection_token_ids',
      StellarSdk.nativeToScVal(slug, { type: 'string' }),
      StellarSdk.nativeToScVal(start, { type: 'u32' }),
      StellarSdk.nativeToScVal(pageSize, { type: 'u32' }),
    ) as never).setTimeout(300).build()
  const sim = await rpc.simulateTransaction(tx)
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(`Could not verify existing on-chain NFTs: ${sim.error}`)
  const retval = (sim as unknown as { result?: { retval?: StellarSdk.xdr.ScVal } }).result?.retval
  if (!retval) throw new Error('Old contract returned no token list; refusing to switch without an on-chain check.')
  const page = StellarSdk.scValToNative(retval)
  if (!Array.isArray(page)) throw new Error('Old contract returned an invalid token list.')
  onChainIds.push(...page.map(Number))
  if (page.length < pageSize) break
}
if (onChainIds.length) throw new Error(`Refusing contract switch: old contract contains ${onChainIds.length} on-chain NFTs in this collection scope.`)
console.log('On-chain preflight passed: the collection scope has no minted token IDs.')

async function submit(operation: StellarSdk.Operation) {
  const account = await rpc.getAccount(deployer)
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.TESTNET })
    .addOperation(operation as never).setTimeout(300).build()
  const prepared = await rpc.prepareTransaction(tx)
  prepared.sign(keypair)
  return waitFor(await rpc.sendTransaction(prepared))
}
async function waitFor(sent: StellarSdk.rpc.Api.SendTransactionResponse) {
  if (sent.status === 'ERROR') throw new Error(`Stellar rejected transaction ${sent.hash}.`)
  for (let i = 0; i < 60; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const result = await rpc.getTransaction(sent.hash)
    if (result.status === 'SUCCESS') return result
    if (result.status === 'FAILED') throw new Error(`Testnet transaction failed: ${sent.hash}`)
  }
  throw new Error(`Timed out waiting for Testnet transaction ${sent.hash}.`)
}
async function invoke(contractId: string, method: string, args: StellarSdk.xdr.ScVal[]) {
  const account = await rpc.getAccount(deployer)
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.TESTNET })
    .addOperation(new StellarSdk.Contract(contractId).call(method, ...args) as never).setTimeout(300).build()
  const sim = await rpc.simulateTransaction(tx)
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(`Unable to simulate ${method}: ${sim.error}`)
  const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build()
  prepared.sign(keypair)
  return waitFor(await rpc.sendTransaction(prepared))
}

const uploaded = await submit(StellarSdk.Operation.uploadContractWasm({ wasm: new Uint8Array(fs.readFileSync(wasmPath)) }))
if (!uploaded.returnValue) throw new Error('WASM upload returned no hash.')
const wasmHash = Uint8Array.from(StellarSdk.scValToNative(uploaded.returnValue as unknown as StellarSdk.xdr.ScVal) as Uint8Array)
const deployed = await submit(StellarSdk.Operation.createCustomContract({
  wasmHash,
  address: StellarSdk.Address.fromString(deployer),
  salt: crypto.randomBytes(32),
  constructorArgs: [
    StellarSdk.nativeToScVal(baseUri, { type: 'string' }),
    StellarSdk.nativeToScVal('NovaMarket Editions', { type: 'string' }),
    StellarSdk.nativeToScVal('STNV', { type: 'string' }),
    StellarSdk.nativeToScVal(deployer, { type: 'address' }),
  ],
}))
if (!deployed.returnValue?.address) throw new Error('Deployment returned no contract address.')
const newContract = StellarSdk.scValToNative(deployed.returnValue as unknown as StellarSdk.xdr.ScVal)
if (typeof newContract !== 'string' || !/^C[A-Z2-7]{55}$/.test(newContract)) throw new Error('Deployment returned an invalid contract address.')
await invoke(newContract, 'set_payment_token', [StellarSdk.nativeToScVal(paymentToken, { type: 'address' })])
console.log(`Updated NFT contract deployed and configured: ${newContract}`)

await withTransaction(async () => {
  const current = await query<any[]>(`SELECT contract_id, owner_wallet FROM collections WHERE slug = ? FOR UPDATE`, [slug])
  if (current.length !== 1 || current[0].contract_id !== oldContract || current[0].owner_wallet !== collection.owner_wallet) throw new Error('Collection changed during deployment; database was not rebound.')
  const stillNoMints = await query<any[]>(`SELECT COUNT(*)::int AS count FROM nft_mints WHERE collection_id = ?`, [slug])
  if (Number(stillNoMints[0]?.count ?? 0)) throw new Error('Mints appeared during deployment; database was not rebound.')
  await query(`INSERT INTO nft_contract_registry (contract_id, owner_wallet, network) VALUES (?, ?, 'TESTNET') ON CONFLICT (contract_id) DO NOTHING`, [newContract, deployer])
  const updated = await query<any[]>(`UPDATE collections SET contract_id = ? WHERE slug = ? AND contract_id = ? RETURNING id`, [newContract, slug, oldContract])
  if (updated.length !== 1) throw new Error('Collection contract pointer update did not affect exactly one row.')
})
function saveEnv(name: string, value: string) {
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const line = `${name}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  const pattern = new RegExp(`^${name}=.*$`, 'm')
  fs.writeFileSync(envPath, pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`, { encoding: 'utf8', mode: 0o600 })
  process.env[name] = value
}
saveEnv('STELLAR_DEPLOYED_NFT_CONTRACT_ID', newContract)
saveEnv('VITE_STELLAR_NFT_CONTRACT_ID', newContract)
console.log(`Rebound collection ${slug} to ${newContract}; saved Testnet NFT contract settings.`)
console.log('Payment token configured on the new contract.')
await closeDatabase()
