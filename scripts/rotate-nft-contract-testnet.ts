import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import * as StellarSdk from '@stellar/stellar-sdk'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envPath = path.join(root, '.env')
loadEnv({ path: envPath })
const args = process.argv.slice(2)
const resumeContract = args.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length)
const target = args.find((arg) => arg !== '--preflight-only' && !arg.startsWith('--resume='))
const preflightOnly = args.includes('--preflight-only')
if (!target) throw new Error('Usage: tsx scripts/rotate-nft-contract-testnet.ts <collection-slug|--all> [--preflight-only] [--resume=<replacement-contract>]')
if ((process.env.VITE_STELLAR_NETWORK ?? '').toUpperCase() !== 'TESTNET') throw new Error('Refusing to rotate NFT contracts unless VITE_STELLAR_NETWORK=TESTNET')
const secret = process.env.STELLAR_DEPLOYER_SECRET
if (!secret) throw new Error('STELLAR_DEPLOYER_SECRET is required; refusing to create or use a different key.')
const oldContract = process.env.STELLAR_DEPLOYED_NFT_CONTRACT_ID ?? process.env.VITE_STELLAR_NFT_CONTRACT_ID ?? ''
if (!/^C[A-Z2-7]{55}$/.test(oldContract)) throw new Error('Could not identify the configured old NFT contract.')
const paymentToken = process.env.VITE_STELLAR_PAYMENT_TOKEN ?? ''
if (!/^C[A-Z2-7]{55}$/.test(paymentToken)) throw new Error('VITE_STELLAR_PAYMENT_TOKEN must be a Stellar contract address.')
const baseUri = `${(process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/`
if (!/^https:\/\/.+\/$/.test(baseUri)) throw new Error('CLOUDFLARE_R2_PUBLIC_BASE_URL must be a public HTTPS URL.')
const wasmPath = path.join(root, 'public/contracts/nftgram_nft.wasm')
if (!fs.existsSync(wasmPath)) throw new Error('Replacement NFT WASM is missing. Run npm run build:nft-contract.')

const keypair = StellarSdk.Keypair.fromSecret(secret)
const admin = keypair.publicKey()
const rpc = new StellarSdk.rpc.Server(process.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org')
const networkPassphrase = StellarSdk.Networks.TESTNET
const { query, withTransaction, ensureSchema, closeDatabase } = await import('../server/db.ts')

type CollectionRow = { slug: string; name: string; owner_wallet: string; contract_id: string | null; revealed: boolean; placeholder_metadata_uri: string | null }
type StageRow = { id: string | number; kind: string; start_time: Date | string | null; end_time: Date | string | null; price_xlm: string | number | null; per_wallet_limit: number; max_supply: number | null; sort_order: number; metadata_uri: string; edition_count: number; is_published: boolean }
type WalletRow = { wallet: string; minted: number; allowed: boolean; custom_limit: number | null; custom_price: string | number | null }
type PreparedCollection = { collection: CollectionRow; stages: StageRow[]; stageWallets: Map<number, WalletRow[]>; stageMinted: Map<number, number> }

function scVec(values: StellarSdk.xdr.ScVal[]): StellarSdk.xdr.ScVal { return StellarSdk.xdr.ScVal.scvVec(values) }
const sc = (value: string | number | bigint | boolean | null, type?: string) => value === null
  ? StellarSdk.nativeToScVal(null)
  : type ? StellarSdk.nativeToScVal(value, { type } as never) : StellarSdk.nativeToScVal(value)

async function waitFor(sent: StellarSdk.rpc.Api.SendTransactionResponse) {
  if (sent.status === 'ERROR') throw new Error(`Stellar Testnet rejected a transaction: ${sent.hash}`)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const result = await rpc.getTransaction(sent.hash)
    if (result.status === 'SUCCESS') return result
    if (result.status === 'FAILED') throw new Error(`Testnet transaction failed: ${sent.hash}`)
  }
  throw new Error(`Timed out waiting for Testnet transaction ${sent.hash}`)
}
async function submit(operation: StellarSdk.Operation) {
  const account = await rpc.getAccount(admin)
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase })
    .addOperation(operation as never).setTimeout(300).build()
  const prepared = await rpc.prepareTransaction(tx)
  prepared.sign(keypair)
  return waitFor(await rpc.sendTransaction(prepared))
}
async function invoke(contractId: string, method: string, args: StellarSdk.xdr.ScVal[]) {
  const account = await rpc.getAccount(admin)
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase })
    .addOperation(new StellarSdk.Contract(contractId).call(method, ...args) as never).setTimeout(300).build()
  const simulation = await rpc.simulateTransaction(tx)
  if (StellarSdk.rpc.Api.isSimulationError(simulation)) throw new Error(`Simulation failed for ${method}: ${simulation.error}`)
  const prepared = StellarSdk.rpc.assembleTransaction(tx, simulation).build()
  prepared.sign(keypair)
  return waitFor(await rpc.sendTransaction(prepared))
}
async function read(contractId: string, method: string, args: StellarSdk.xdr.ScVal[]) {
  const account = await rpc.getAccount(admin)
  const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase })
    .addOperation(new StellarSdk.Contract(contractId).call(method, ...args) as never).setTimeout(300).build()
  const result = await rpc.simulateTransaction(tx)
  if (StellarSdk.rpc.Api.isSimulationError(result)) throw new Error(`Could not verify ${method} on ${contractId}: ${result.error}`)
  const retval = (result as unknown as { result?: { retval?: StellarSdk.xdr.ScVal } }).result?.retval
  if (!retval) throw new Error(`Could not read ${method} from ${contractId}`)
  return StellarSdk.scValToNative(retval)
}
async function collectionTokenIds(contractId: string, scope: string): Promise<number[]> {
  const ids: number[] = []
  for (let start = 0; ; start += 100) {
    const account = await rpc.getAccount(admin)
    const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase })
      .addOperation(new StellarSdk.Contract(contractId).call('collection_token_ids', sc(scope, 'string'), sc(start, 'u32'), sc(100, 'u32')) as never)
      .setTimeout(300).build()
    const result = await rpc.simulateTransaction(tx)
    if (StellarSdk.rpc.Api.isSimulationError(result)) throw new Error(`Cannot verify old contract token IDs for ${scope}: ${result.error}`)
    const raw = (result as unknown as { result?: { retval?: StellarSdk.xdr.ScVal } }).result?.retval
    if (!raw) throw new Error('Old NFT contract did not return collection token IDs; refusing migration.')
    const page = StellarSdk.scValToNative(raw)
    if (!Array.isArray(page)) throw new Error('Old NFT contract returned an invalid token list; refusing migration.')
    ids.push(...page.map(Number))
    if (page.length < 100) return ids
  }
}
function stroops(value: string | number | null): bigint {
  if (value === null) return 0n
  const text = String(value)
  if (!/^\d+(?:\.\d{1,7})?$/.test(text)) throw new Error(`Invalid XLM stage price: ${text}`)
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
}
function seconds(value: Date | string | null, name: string): bigint {
  if (!value) throw new Error(`Published stage is missing ${name}; cannot migrate it safely.`)
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`Published stage has invalid ${name}.`)
  return BigInt(Math.floor(date.getTime() / 1000))
}
function saveEnv(name: string, value: string) {
  const source = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const line = `${name}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  const pattern = new RegExp(`^${name}=.*$`, 'm')
  fs.writeFileSync(envPath, pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`, { encoding: 'utf8', mode: 0o600 })
  process.env[name] = value
}

try {
  await ensureSchema()
  const collections = target === '--all'
    ? await query<CollectionRow[]>('SELECT slug, name, owner_wallet, contract_id, revealed, placeholder_metadata_uri FROM collections WHERE LOWER(contract_id) = LOWER(?) ORDER BY slug', [oldContract])
    : await query<CollectionRow[]>('SELECT slug, name, owner_wallet, contract_id, revealed, placeholder_metadata_uri FROM collections WHERE slug = ? AND LOWER(contract_id) = LOWER(?)', [target, oldContract])
  if (!collections.length) throw new Error(`No collections currently use the old NFT contract ${oldContract}.`)
  if (target !== '--all' && collections.length !== 1) throw new Error(`Expected exactly one collection named ${target}; found ${collections.length}.`)

  const preparedCollections: PreparedCollection[] = []
  let totalTokens = 0
  let totalStages = 0
  for (const collection of collections) {
    const slug = collection.slug
    if (collection.contract_id !== oldContract) throw new Error(`Collection ${slug} changed contract since preflight; refusing to rotate.`)
    if (!/^G[A-Z2-7]{55}$/.test(collection.owner_wallet)) throw new Error(`Collection ${slug} has an invalid creator wallet.`)
    if (!collection.revealed && !/^https:\/\//i.test(collection.placeholder_metadata_uri ?? '')) throw new Error(`Unrevealed collection ${slug} has no valid placeholder URI.`)
    const dbTokens = await query<{ token_id: number }[]>(
      'SELECT token_id FROM nft_mints WHERE LOWER(contract_id) = LOWER(?) AND collection_id = ? ORDER BY token_id', [oldContract, slug],
    )
    const oldIds = await collectionTokenIds(oldContract, slug)
    if (oldIds.length !== dbTokens.length) throw new Error(`${slug}: token counts do not reconcile (${oldIds.length} on-chain, ${dbTokens.length} indexed); wait for indexing and retry.`)
    const dbIds = new Set(dbTokens.map((row) => Number(row.token_id)))
    if (oldIds.some((id) => !dbIds.has(id))) throw new Error(`${slug}: on-chain token IDs do not match indexed tokens; refusing to switch.`)
    totalTokens += oldIds.length

    const stages = await query<StageRow[]>(
      'SELECT id, kind, start_time, end_time, price_xlm, per_wallet_limit, max_supply, sort_order, metadata_uri, edition_count, is_published FROM mint_stages WHERE collection_id = ? AND is_published = TRUE ORDER BY id', [slug],
    )
    const stageWallets = new Map<number, WalletRow[]>()
    const stageMinted = new Map<number, number>()
    for (const stage of stages) {
    const stageId = Number(stage.id)
    if (!Number.isSafeInteger(stageId) || stageId < 0 || stageId > 0xffff_ffff) throw new Error(`Stage ${stage.id} is outside the contract's u32 stage ID range.`)
    if (!['team', 'guaranteed', 'fcfs', 'public'].includes(stage.kind)) throw new Error(`Stage ${stageId} uses unsupported kind ${stage.kind}.`)
    const [events, allowlist, indexedStageMints] = await Promise.all([
      query<{ wallet: string; minted: number }[]>(
        'SELECT wallet, COALESCE(SUM(CARDINALITY(token_ids)), 0)::int AS minted FROM stage_mint_events WHERE LOWER(contract_id) = LOWER(?) AND stage_id = ? GROUP BY wallet', [oldContract, stageId],
      ),
      query<{ wallet: string; custom_limit: number | null; custom_price: string | number | null }[]>(
        'SELECT wallet, custom_limit, custom_price FROM mint_whitelist WHERE stage_id = ? ORDER BY wallet', [stageId],
      ),
      query<{ count: number }[]>(
        'SELECT COUNT(*)::int AS count FROM nft_mints WHERE LOWER(contract_id) = LOWER(?) AND collection_id = ? AND stage_id = ?', [oldContract, slug, stageId],
      ),
    ])
    const eventCount = events.reduce((total, row) => total + Number(row.minted), 0)
    if (eventCount !== Number(indexedStageMints[0]?.count ?? 0)) throw new Error(`Stage ${stageId} mint events do not reconcile with indexed NFT rows; wait for indexing and retry.`)
    stageMinted.set(stageId, eventCount)
    const wallets = new Map<string, WalletRow>()
    for (const event of events) wallets.set(event.wallet.toLowerCase(), { wallet: event.wallet, minted: Number(event.minted), allowed: stage.kind === 'public', custom_limit: null, custom_price: null })
    for (const entry of allowlist) {
      const key = entry.wallet.toLowerCase()
      const prior = wallets.get(key)
      wallets.set(key, { wallet: entry.wallet, minted: prior?.minted ?? 0, allowed: true, custom_limit: entry.custom_limit, custom_price: entry.custom_price })
    }
      stageWallets.set(stageId, [...wallets.values()])
    }
    totalStages += stages.length
    preparedCollections.push({ collection, stages, stageWallets, stageMinted })
  }
  console.log(`Preflight passed: ${collections.length} collection(s), ${totalTokens} existing NFTs reconcile with the old contract, and ${totalStages} published stage(s) reconcile with mint rows and wallet counters.`)

  if (preflightOnly) {
    console.log('Preflight-only mode: no contract transactions or database updates were submitted.')
  } else {

  let newContract = resumeContract ?? ''
  if (resumeContract) {
    if (!/^C[A-Z2-7]{55}$/.test(resumeContract)) throw new Error('--resume must be a Stellar contract address.')
    const candidateAdmin = await read(resumeContract, 'admin', [])
    const candidatePaymentToken = await read(resumeContract, 'payment_token', [])
    if (String(candidateAdmin).toLowerCase() !== admin.toLowerCase()) throw new Error('The resume contract has a different admin; refusing to switch collection pointers.')
    if (String(candidatePaymentToken).toLowerCase() !== paymentToken.toLowerCase()) throw new Error('The resume contract has a different payment token; refusing to switch collection pointers.')
    for (const { collection, stages, stageMinted } of preparedCollections) {
      const candidateOwner = await read(resumeContract, 'collection_owner', [sc(collection.slug, 'string')])
      if (String(candidateOwner).toLowerCase() !== collection.owner_wallet.toLowerCase()) throw new Error(`The resume contract has the wrong or missing creator for ${collection.slug}.`)
      for (const stage of stages) {
        const id = Number(stage.id)
        const candidateMinted = Number(await read(resumeContract, 'stage_minted', [sc(id, 'u32')]))
        if (candidateMinted !== (stageMinted.get(id) ?? 0)) throw new Error(`The resume contract has a mismatched mint counter for stage ${id}.`)
      }
    }
    console.log(`Verified fully imported replacement contract: ${resumeContract}`)
  } else {
  const uploaded = await submit(StellarSdk.Operation.uploadContractWasm({ wasm: new Uint8Array(fs.readFileSync(wasmPath)) }))
  if (!uploaded.returnValue) throw new Error('WASM upload returned no hash.')
  const wasmHash = Uint8Array.from(StellarSdk.scValToNative(uploaded.returnValue as unknown as StellarSdk.xdr.ScVal) as Uint8Array)
  if (wasmHash.length !== 32) throw new Error('WASM upload returned an invalid code hash.')
  const deployed = await submit(StellarSdk.Operation.createCustomContract({
    wasmHash, address: StellarSdk.Address.fromString(admin), salt: crypto.randomBytes(32),
    constructorArgs: [sc(baseUri, 'string'), sc('StellaNova Editions', 'string'), sc('STNV', 'string'), sc(admin, 'address')],
  }))
  const deployedContract = deployed.returnValue
    ? StellarSdk.scValToNative(deployed.returnValue as unknown as StellarSdk.xdr.ScVal)
    : null
  if (typeof deployedContract !== 'string' || !/^C[A-Z2-7]{55}$/.test(deployedContract)) throw new Error('Deployment did not return a valid NFT contract address.')
  newContract = deployedContract
  console.log(`Replacement NFT contract deployed: ${newContract}`)

  await invoke(newContract, 'set_payment_token', [sc(paymentToken, 'address')])
  for (const { collection, stages, stageWallets, stageMinted } of preparedCollections) {
    const slug = collection.slug
    await invoke(newContract, 'import_collection_state', [
      sc(collection.owner_wallet, 'address'), sc(slug, 'string'), sc(collection.revealed, 'bool'), sc(collection.placeholder_metadata_uri ?? '', 'string'),
    ])
    for (const stage of stages) {
      const id = Number(stage.id)
      await invoke(newContract, 'import_creator_stage', [
        sc(collection.owner_wallet, 'address'), sc(id, 'u32'), sc(stage.kind, 'symbol'), sc(seconds(stage.start_time, 'start time'), 'u64'), sc(seconds(stage.end_time, 'end time'), 'u64'),
        sc(stroops(stage.price_xlm), 'i128'), sc(Number(stage.per_wallet_limit), 'u32'), sc(Number(stage.max_supply ?? 0), 'u32'),
        sc(Number(stage.sort_order), 'u32'), sc(slug, 'string'), sc(stage.metadata_uri || collection.placeholder_metadata_uri || '', 'string'),
        sc(Number(stage.edition_count || 1), 'u32'), sc(stageMinted.get(id) ?? 0, 'u32'),
      ])
      const rows = stageWallets.get(id) ?? []
      for (let offset = 0; offset < rows.length; offset += 20) {
        const batch = rows.slice(offset, offset + 20)
        await invoke(newContract, 'import_stage_wallets', [
          sc(id, 'u32'),
          scVec(batch.map((row) => sc(row.wallet, 'address'))),
          scVec(batch.map((row) => sc(row.minted, 'u32'))),
          scVec(batch.map((row) => sc(row.allowed, 'bool'))),
          scVec(batch.map((row) => row.custom_limit === null ? sc(null) : sc(Number(row.custom_limit), 'u32'))),
          scVec(batch.map((row) => row.custom_price === null ? sc(null) : sc(stroops(row.custom_price), 'i128'))),
        ])
      }
    }
    await invoke(newContract, 'complete_collection_import', [sc(slug, 'string')])
  }
  }

  await query(`CREATE TABLE IF NOT EXISTS collection_nft_contracts (collection_slug VARCHAR(160) NOT NULL, contract_id VARCHAR(56) NOT NULL, is_active BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (collection_slug, contract_id))`)
  await withTransaction(async () => {
    await query('INSERT INTO nft_contract_registry (contract_id, owner_wallet, network) VALUES (?, ?, ?) ON CONFLICT (contract_id) DO NOTHING', [newContract, admin, 'TESTNET'])
    for (const { collection } of preparedCollections) {
      const slug = collection.slug
      const current = await query<CollectionRow[]>(
        'SELECT slug, name, owner_wallet, contract_id, revealed, placeholder_metadata_uri FROM collections WHERE slug = ? FOR UPDATE', [slug],
      )
      if (current.length !== 1 || current[0].contract_id !== oldContract || current[0].owner_wallet !== collection.owner_wallet) throw new Error(`Collection ${slug} changed during deployment; no collection pointers were changed.`)
      await query('INSERT INTO collection_nft_contracts (collection_slug, contract_id, is_active) VALUES (?, ?, FALSE) ON CONFLICT (collection_slug, contract_id) DO UPDATE SET is_active = FALSE', [slug, oldContract])
      await query('INSERT INTO collection_nft_contracts (collection_slug, contract_id, is_active) VALUES (?, ?, TRUE) ON CONFLICT (collection_slug, contract_id) DO UPDATE SET is_active = TRUE', [slug, newContract])
      await query('UPDATE collection_nft_contracts SET is_active = FALSE WHERE collection_slug = ? AND LOWER(contract_id) <> LOWER(?)', [slug, newContract])
      const updated = await query<{ slug: string }[]>('UPDATE collections SET contract_id = ? WHERE slug = ? AND contract_id = ? RETURNING slug', [newContract, slug, oldContract])
      if (updated.length !== 1) throw new Error(`Collection ${slug} contract pointer did not update exactly once.`)
    }
  })

  saveEnv('STELLAR_DEPLOYED_NFT_CONTRACT_ID', newContract)
  saveEnv('VITE_STELLAR_NFT_CONTRACT_ID', newContract)
  console.log(`${preparedCollections.length} collection(s) now mint on ${newContract}. Existing NFT rows, ownership, and old contract/listings remain unchanged.`)
  console.log('The replacement contract is admin-upgradeable through its upgrade(wasm_hash) method; admin changes require proposal and acceptance.')
  }
} finally {
  await closeDatabase()
}
