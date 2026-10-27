import { Buffer } from 'buffer'
import * as StellarSdk from '@stellar/stellar-sdk'
import { scValToNative } from '@stellar/stellar-sdk'
import { signStellarTransaction, STELLAR_NETWORK_PASSPHRASE, SOROBAN_RPC_URL, type StellarWallet } from './stellar'

const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL)
const fallbackNftContractId = import.meta.env.VITE_STELLAR_NFT_CONTRACT_ID ?? 'CDEESFFVHROBZDWVK7CCKTUFGGATKIZOIOS4BHA7V6ENRF3W25C6FBOR'

export function getSorobanNftContractId(): string {
  if (typeof window !== 'undefined') {
    const deployed = window.localStorage.getItem('nftgram:nft-contract')
    if (deployed) return deployed
  }
  return fallbackNftContractId
}

type SuccessfulResponse = {
  hash: string
  status: string
  returnValue?: StellarSdk.xdr.ScVal & { bytes: () => Buffer; address: () => unknown }
  rawReturnValue?: StellarSdk.xdr.ScVal
}

async function submitPrepared(transaction: StellarSdk.Transaction, wallet: StellarWallet, onProgress?: (stage: 'awaiting-wallet' | 'confirming') => void): Promise<SuccessfulResponse> {
  onProgress?.('awaiting-wallet')
  const signedXdr = await signStellarTransaction(transaction.toXDR(), wallet.address, wallet.networkPassphrase, wallet.provider)
  const signed = StellarSdk.TransactionBuilder.fromXDR(signedXdr, wallet.networkPassphrase)
  const sent = await server.sendTransaction(signed)
  if (sent.status === 'ERROR') throw new Error('Stellar rejected the transaction before submission')
  onProgress?.('confirming')

  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000))
    const result = await server.getTransaction(sent.hash)
    if (result.status === 'SUCCESS') {
      const response = result as unknown as SuccessfulResponse
      // Keep the raw ScVal so scalar return values (e.g. u32 token ids from
      // `mint`) can be decoded with scValToNative. `getTransaction` responses
      // do not carry the submission response's `hash`; preserve it here for
      // the indexer and transaction history.
      response.rawReturnValue = result.returnValue as StellarSdk.xdr.ScVal
      response.hash = sent.hash
      return response
    }
    if (result.status === 'FAILED') throw new Error(`Stellar transaction failed: ${sent.hash}`)
  }
  throw new Error(`Timed out while confirming Stellar transaction ${sent.hash}`)
}

async function prepareAndSubmit(operation: StellarSdk.Operation, wallet: StellarWallet) {
  const account = await getSourceAccount(wallet)
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: wallet.networkPassphrase || STELLAR_NETWORK_PASSPHRASE,
  }).addOperation(operation as never).setTimeout(300).build()
  return submitPrepared(await server.prepareTransaction(transaction), wallet)
}

export async function deploySorobanWasm(wasmUrl: string, wallet: StellarWallet, constructorArgs: StellarSdk.xdr.ScVal[]) {
  const wasm = await fetch(wasmUrl).then(async (response) => {
    if (!response.ok) throw new Error(`Unable to load contract Wasm (${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  })

  const install = await prepareAndSubmit(StellarSdk.Operation.uploadContractWasm({ wasm }), wallet)
  if (!install.returnValue) throw new Error('Stellar did not return a Wasm hash after installation')

  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
  const deployed = await prepareAndSubmit(StellarSdk.Operation.createCustomContract({
    wasmHash: install.returnValue.bytes(),
    address: StellarSdk.Address.fromString(wallet.address),
    salt,
    constructorArgs,
  }), wallet)
  if (!deployed.returnValue?.address) throw new Error('Stellar did not return a contract address after deployment')

  const contractAddress = StellarSdk.StrKey.encodeContract(
    StellarSdk.Address.fromScAddress(deployed.returnValue.address() as any).toBuffer(),
  )
  return { contractAddress, installHash: install.hash, deployHash: deployed.hash }
}

async function getSourceAccount(wallet: StellarWallet) {
  let rpcLookupError: unknown
  try {
    return await server.getAccount(wallet.address)
  } catch (error) {
    rpcLookupError = error
  }

  // A wallet can be active and funded on Horizon even if Soroban RPC's
  // getAccount lookup is temporarily unavailable or returns a stale 404.
  // TransactionBuilder only needs the account sequence, which Horizon also
  // provides, so use it before treating the wallet as unactivated.
  const horizonUrl = wallet.network === 'PUBLIC'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org'
  const horizon = new StellarSdk.Horizon.Server(horizonUrl)
  try {
    return await horizon.loadAccount(wallet.address)
  } catch (horizonError) {
    const rpcMessage = rpcLookupError instanceof Error ? rpcLookupError.message : String(rpcLookupError)
    const horizonMessage = horizonError instanceof Error ? horizonError.message : String(horizonError)
    const accountMissing = /not found|404|resource missing/i.test(horizonMessage)
    if (!accountMissing) {
      throw new Error(`Could not load your ${wallet.network === 'PUBLIC' ? 'Stellar Mainnet' : 'Stellar Testnet'} wallet account. Soroban RPC: ${rpcMessage}. Horizon: ${horizonMessage}.`)
    }
    if (wallet.network !== 'TESTNET') {
      throw new Error('This wallet address is not activated on Stellar Mainnet. Connect the funded Mainnet wallet and retry.')
    }

    try {
      const response = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(wallet.address)}`)
      if (!response.ok) throw new Error(`Friendbot returned ${response.status}`)
      return await horizon.loadAccount(wallet.address)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`This wallet address was not found on Stellar Testnet. Automatic Testnet funding could not be confirmed (${reason}). Check that the connected address is the same funded wallet, then retry.`)
    }
  }
}

/** Simulate a read-only contract method without requesting a wallet signature. */
export async function simulateSorobanRead(contractId: string, method: string, args: StellarSdk.xdr.ScVal[], wallet: StellarWallet) {
  const account = await getSourceAccount(wallet)
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: wallet.networkPassphrase || STELLAR_NETWORK_PASSPHRASE,
  }).addOperation(new StellarSdk.Contract(contractId).call(method, ...args) as never).setTimeout(30).build()
  const simulation = await server.simulateTransaction(transaction)
  if (StellarSdk.rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error)
  if (!simulation.result) throw new Error(`Could not read ${method} from the contract`)
  return StellarSdk.scValToNative(simulation.result.retval)
}

export async function invokeSoroban(contractId: string, method: string, args: StellarSdk.xdr.ScVal[], wallet: StellarWallet, onProgress?: (stage: 'awaiting-wallet' | 'confirming') => void) {
  const account = await getSourceAccount(wallet)
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: wallet.networkPassphrase || STELLAR_NETWORK_PASSPHRASE,
  }).addOperation(new StellarSdk.Contract(contractId).call(method, ...args) as never).setTimeout(300).build()
  const simulation = await server.simulateTransaction(transaction)
  if (StellarSdk.rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error)
  return submitPrepared(StellarSdk.rpc.assembleTransaction(transaction, simulation).build(), wallet, onProgress)
}

export async function invokeSorobanBatch(contractId: string, calls: { method: string; args: StellarSdk.xdr.ScVal[] }[], wallet: StellarWallet) {
  if (!calls.length) throw new Error('Add at least one contract action to the batch')
  if (calls.length > 10) throw new Error('A wallet transaction can contain up to 10 contract actions; split this batch and retry')
  const account = await getSourceAccount(wallet)
  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: wallet.networkPassphrase || STELLAR_NETWORK_PASSPHRASE,
  })
  const contract = new StellarSdk.Contract(contractId)
  for (const call of calls) builder.addOperation(contract.call(call.method, ...call.args) as never)
  const transaction = builder.setTimeout(300).build()
  const simulation = await server.simulateTransaction(transaction)
  if (StellarSdk.rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error)
  return submitPrepared(StellarSdk.rpc.assembleTransaction(transaction, simulation).build(), wallet)
}

export async function sendXlmTip(wallet: StellarWallet, recipient: string, postId: number, amount: string, onProgress?: (stage: 'awaiting-wallet' | 'confirming') => void) {
  const cleanAmount = amount.trim()
  const value = Number(cleanAmount)
  if (!/^\d+(?:\.\d{1,7})?$/.test(cleanAmount) || !Number.isFinite(value) || value <= 0 || value > 10_000) throw new Error('Enter a tip between 0.0000001 and 10,000 XLM')
  if (!/^G[A-Z2-7]{55}$/.test(recipient)) throw new Error('This creator does not have a valid Stellar wallet')
  if (recipient.toLowerCase() === wallet.address.toLowerCase()) throw new Error('You cannot tip your own post')
  if (!Number.isSafeInteger(postId) || postId <= 0) throw new Error('This post does not have a valid tip reference')
  const horizonUrl = wallet.network === 'PUBLIC' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org'
  const horizon = new StellarSdk.Horizon.Server(horizonUrl)
  const account = await horizon.loadAccount(wallet.address)
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: wallet.networkPassphrase || STELLAR_NETWORK_PASSPHRASE,
  }).addOperation(StellarSdk.Operation.payment({
    destination: recipient,
    asset: StellarSdk.Asset.native(),
    amount: value.toFixed(7).replace(/0+$/, '').replace(/\.$/, ''),
  })).addMemo(StellarSdk.Memo.text(`SN tip ${postId}`)).setTimeout(300).build()

  onProgress?.('awaiting-wallet')
  const signedXdr = await signStellarTransaction(transaction.toXDR(), wallet.address, wallet.networkPassphrase, wallet.provider)
  const signed = StellarSdk.TransactionBuilder.fromXDR(signedXdr, wallet.networkPassphrase) as StellarSdk.Transaction
  const expectedHash = Buffer.from(signed.hash()).toString('hex')
  onProgress?.('confirming')
  try {
    const result = await horizon.submitTransaction(signed)
    return { hash: result.hash, amount: cleanAmount }
  } catch (error) {
    // A transport error can arrive after Horizon accepted the payment. Check
    // the locally known transaction hash before telling the user to retry.
    try {
      const confirmed = await horizon.transactions().transaction(expectedHash).call()
      if (confirmed.successful) return { hash: expectedHash, amount: cleanAmount }
    } catch { /* Horizon has no confirmed transaction at this hash. */ }
    const cause = error as { response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } }; message?: string }
    const operationCode = cause.response?.data?.extras?.result_codes?.operations?.[0]
    const transactionCode = cause.response?.data?.extras?.result_codes?.transaction
    const detail = operationCode || transactionCode || cause.message
    throw new Error(detail ? `Stellar could not confirm the tip (${detail})` : 'Stellar could not confirm the tip')
  }
}

/** Send one direct native XLM payment tagged for a creator-service order. */
export async function sendXlmOrderPayment(wallet: StellarWallet, recipient: string, orderId: number, amount: string, onProgress?: (stage: 'awaiting-wallet' | 'confirming') => void) {
  const cleanAmount = amount.trim()
  const value = Number(cleanAmount)
  if (!/^\d+(?:\.\d{1,7})?$/.test(cleanAmount) || !Number.isFinite(value) || value <= 0 || value > 10_000) throw new Error('Enter an XLM payment between 0.0000001 and 10,000 XLM')
  if (!/^G[A-Z2-7]{55}$/.test(recipient) || recipient.toLowerCase() === wallet.address.toLowerCase()) throw new Error('This creator does not have a valid receiving wallet')
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('This order has an invalid payment reference')
  const horizonUrl = wallet.network === 'PUBLIC' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org'
  const horizon = new StellarSdk.Horizon.Server(horizonUrl)
  const account = await horizon.loadAccount(wallet.address)
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: wallet.networkPassphrase || STELLAR_NETWORK_PASSPHRASE,
  }).addOperation(StellarSdk.Operation.payment({
    destination: recipient,
    asset: StellarSdk.Asset.native(),
    amount: value.toFixed(7).replace(/0+$/, '').replace(/\.$/, ''),
  })).addMemo(StellarSdk.Memo.text(`SN order ${orderId}`)).setTimeout(300).build()
  onProgress?.('awaiting-wallet')
  const signedXdr = await signStellarTransaction(transaction.toXDR(), wallet.address, wallet.networkPassphrase, wallet.provider)
  const signed = StellarSdk.TransactionBuilder.fromXDR(signedXdr, wallet.networkPassphrase) as StellarSdk.Transaction
  const expectedHash = Buffer.from(signed.hash()).toString('hex')
  onProgress?.('confirming')
  try {
    const result = await horizon.submitTransaction(signed)
    return { hash: result.hash, amount: cleanAmount }
  } catch (error) {
    try {
      const confirmed = await horizon.transactions().transaction(expectedHash).call()
      if (confirmed.successful) return { hash: expectedHash, amount: cleanAmount }
    } catch { /* Horizon has no confirmed transaction at this hash. */ }
    const cause = error as { response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } }; message?: string }
    const code = cause.response?.data?.extras?.result_codes?.operations?.[0] || cause.response?.data?.extras?.result_codes?.transaction || cause.message
    throw new Error(code ? `Stellar could not confirm the payment (${code})` : 'Stellar could not confirm the payment')
  }
}

/**
 * Extracts a scalar u32 value from a successful Soroban call's return value.
 * Returns null when the call did not return a number (e.g. void methods).
 */
export function u32FromResult(result: { rawReturnValue?: StellarSdk.xdr.ScVal }): number | null {
  const rv = result.rawReturnValue
  if (!rv) return null
  try {
    const native = scValToNative(rv)
    return typeof native === 'number' ? native : null
  } catch {
    return null
  }
}

export function u32sFromResult(result: { rawReturnValue?: StellarSdk.xdr.ScVal }): number[] {
  const rv = result.rawReturnValue
  if (!rv) return []
  try {
    const native = scValToNative(rv)
    return Array.isArray(native) ? native.map(Number).filter((value) => Number.isSafeInteger(value) && value >= 0) : []
  } catch {
    return []
  }
}

/**
 * Mints a new NFT on the deployed SEP-50 contract on behalf of a wallet.
 * Only the contract's configured owner (deployer) can mint. Returns the new
 * token id as reported by the on-chain `mint` call.
 */
export async function mintNft(wallet: StellarWallet, to?: string): Promise<{ tokenId: number | null; hash: string }> {
  if (!sorobanNftContractId) throw new Error('The NFT contract is not configured')
  const result = await invokeSoroban(sorobanNftContractId, 'mint', [
    StellarSdk.nativeToScVal(to ?? wallet.address, { type: 'address' }),
  ], wallet)
  return { tokenId: u32FromResult(result), hash: result.hash }
}

export async function mintNftWithMetadata(wallet: StellarWallet, contractId: string, collectionScope: string, metadataUri: string) {
  if (!contractId) throw new Error('The NFT contract is not configured')
  const result = await invokeSoroban(contractId, 'mint_with_metadata', [
    StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
    StellarSdk.nativeToScVal(collectionScope, { type: 'string' }),
    StellarSdk.nativeToScVal(metadataUri, { type: 'string' }),
  ], wallet)
  return { tokenId: u32FromResult(result), hash: result.hash }
}

export async function setCreatorReveal(wallet: StellarWallet, contractId: string, input: { collectionScope: string; revealed: boolean; placeholderUri: string }) {
  if (!contractId) throw new Error('The NFT contract is not configured')
  return invokeSoroban(contractId, 'set_creator_reveal', [
    StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
    StellarSdk.nativeToScVal(input.collectionScope, { type: 'string' }),
    StellarSdk.nativeToScVal(input.revealed, { type: 'bool' }),
    StellarSdk.nativeToScVal(input.placeholderUri, { type: 'string' }),
  ], wallet)
}

export async function setCreatorTokenUris(wallet: StellarWallet, contractId: string, collectionScope: string, tokenIds: number[], metadataUris: string[]) {
  if (!contractId) throw new Error('The NFT contract is not configured')
  if (!tokenIds.length || tokenIds.length > 20 || tokenIds.length !== metadataUris.length) throw new Error('Reveal batches need 1–20 matching tokens and metadata URLs')
  return invokeSoroban(contractId, 'set_creator_token_uris', [
    StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
    StellarSdk.nativeToScVal(collectionScope, { type: 'string' }),
    StellarSdk.nativeToScVal(tokenIds, { type: 'u32' }),
    StellarSdk.nativeToScVal(metadataUris, { type: 'string' }),
  ], wallet)
}

export async function getCreatorCollectionTokenIds(wallet: StellarWallet, contractId: string, collectionScope: string) {
  const ids: number[] = []
  const pageSize = 100
  for (let start = 0; ; start += pageSize) {
    const account = await server.getAccount(wallet.address)
    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: wallet.networkPassphrase || STELLAR_NETWORK_PASSPHRASE,
    }).addOperation(new StellarSdk.Contract(contractId).call('collection_token_ids',
      StellarSdk.nativeToScVal(collectionScope, { type: 'string' }),
      StellarSdk.nativeToScVal(start, { type: 'u32' }),
      StellarSdk.nativeToScVal(pageSize, { type: 'u32' }),
    ) as never).setTimeout(300).build()
    const simulation = await server.simulateTransaction(transaction)
    if (StellarSdk.rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error)
    const retval = (simulation as unknown as { result?: { retval?: StellarSdk.xdr.ScVal } }).result?.retval
    if (!retval) throw new Error('Unable to read collection token ids from Stellar')
    const page = scValToNative(retval)
    if (!Array.isArray(page)) throw new Error('The NFT contract returned an invalid token list')
    ids.push(...page.map(Number))
    if (page.length < pageSize) return ids
  }
}

export async function setCreatorStage(wallet: StellarWallet, contractId: string, input: {
  stageId: number; kind: string; startTime: number; endTime: number; priceStroops: bigint;
  perWalletLimit: number; maxSupply: number; sortOrder: number; collectionSlug: string; metadataUri: string; editionCount: number
}) {
  if (!contractId) throw new Error('The NFT contract is not configured')
  return invokeSoroban(contractId, 'set_creator_stage', [
    StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
    StellarSdk.nativeToScVal(input.stageId, { type: 'u32' }),
    StellarSdk.nativeToScVal(input.kind, { type: 'symbol' }),
    StellarSdk.nativeToScVal(BigInt(input.startTime), { type: 'u64' }),
    StellarSdk.nativeToScVal(BigInt(input.endTime), { type: 'u64' }),
    StellarSdk.nativeToScVal(input.priceStroops, { type: 'i128' }),
    StellarSdk.nativeToScVal(input.perWalletLimit, { type: 'u32' }),
    StellarSdk.nativeToScVal(input.maxSupply, { type: 'u32' }),
    StellarSdk.nativeToScVal(input.sortOrder, { type: 'u32' }),
    StellarSdk.nativeToScVal(input.collectionSlug, { type: 'string' }),
    StellarSdk.nativeToScVal(input.metadataUri, { type: 'string' }),
    StellarSdk.nativeToScVal(input.editionCount, { type: 'u32' }),
  ], wallet)
}

export async function removeCreatorStage(wallet: StellarWallet, contractId: string, stageId: number) {
  if (!contractId) throw new Error('The NFT contract is not configured')
  return invokeSoroban(contractId, 'remove_creator_stage', [
    StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
    StellarSdk.nativeToScVal(stageId, { type: 'u32' }),
  ], wallet)
}

export async function whitelistCreatorWallet(wallet: StellarWallet, contractId: string, stageId: number, entry: { wallet: string; allowed: boolean; customLimit: number | null; customPriceStroops: bigint | null }) {
  if (!contractId) throw new Error('The NFT contract is not configured')
  return invokeSoroban(contractId, 'whitelist_creator_wallet', [
    StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
    StellarSdk.nativeToScVal(stageId, { type: 'u32' }),
    StellarSdk.nativeToScVal(entry.wallet, { type: 'address' }),
    StellarSdk.nativeToScVal(entry.allowed, { type: 'bool' }),
    entry.customLimit === null ? StellarSdk.nativeToScVal(null) : StellarSdk.nativeToScVal(entry.customLimit, { type: 'u32' }),
    entry.customPriceStroops === null ? StellarSdk.nativeToScVal(null) : StellarSdk.nativeToScVal(entry.customPriceStroops, { type: 'i128' }),
  ], wallet)
}

export async function whitelistCreatorWalletBatch(wallet: StellarWallet, contractId: string, stageId: number, entries: { wallet: string; customLimit: number | null; customPriceStroops: bigint | null }[]) {
  return invokeSorobanBatch(contractId, entries.map((entry) => ({ method: 'whitelist_creator_wallet', args: [
    StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
    StellarSdk.nativeToScVal(stageId, { type: 'u32' }),
    StellarSdk.nativeToScVal(entry.wallet, { type: 'address' }),
    StellarSdk.nativeToScVal(true, { type: 'bool' }),
    entry.customLimit === null ? StellarSdk.nativeToScVal(null) : StellarSdk.nativeToScVal(entry.customLimit, { type: 'u32' }),
    entry.customPriceStroops === null ? StellarSdk.nativeToScVal(null) : StellarSdk.nativeToScVal(entry.customPriceStroops, { type: 'i128' }),
  ] })), wallet)
}

export async function mintFromStage(wallet: StellarWallet, contractId: string, stageId: number, quantity = 1) {
  if (!contractId) throw new Error('The NFT contract is not configured')
  const result = await invokeSoroban(contractId, 'mint_from_stage', [
    StellarSdk.nativeToScVal(stageId, { type: 'u32' }),
    StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
    StellarSdk.nativeToScVal(quantity, { type: 'u32' }),
  ], wallet)
  let editionStart = 0
  let tokenIds: number[] = []
  try {
    const decoded = result.rawReturnValue ? scValToNative(result.rawReturnValue) : null
    if (Array.isArray(decoded) && Array.isArray(decoded[1])) {
      editionStart = Number(decoded[0])
      tokenIds = decoded[1].map(Number)
    }
  } catch { /* report missing return data to the mint flow */ }
  return { editionStart, tokenIds, hash: result.hash }
}

// The deployed NFT contract id for on-chain mints.
export const sorobanNftContractId = fallbackNftContractId
