import { config as loadEnv } from 'dotenv'
loadEnv()
import { createHash } from 'node:crypto'
import * as StellarSdk from '@stellar/stellar-sdk'
import { ensureSchema, query, withTransaction } from './db.js'
import { mailConfigured, marketplaceEmail, sendMail } from './mail.js'
import { notifyUser } from './push.js'

const rpcUrl = process.env.STELLAR_RPC_URL ?? process.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'
const marketplaceId = process.env.STELLAR_MARKETPLACE_CONTRACT_ID ?? process.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? 'CDQJZ6TKAAUIZW7AMH7XKECRHNVDU4REGMWU7RLJGM5AHIQYZS7GC6TL'
const nftId = process.env.STELLAR_NFT_CONTRACT_ID ?? process.env.VITE_STELLAR_NFT_CONTRACT_ID ?? 'CDEESFFVHROBZDWVK7CCKTUFGGATKIZOIOS4BHA7V6ENRF3W25C6FBOR'
let nftContractIds = new Set<string>(nftId ? [nftId] : [])
let cursor = Number(process.env.STELLAR_INDEXER_START_LEDGER ?? 0)
// Soroban RPC can expose contract events several ledgers after advancing the
// latest-ledger watermark. Re-scan a short window behind the checkpoint; event
// keys make this replay idempotent and prevent late events from being skipped.
// Re-scan enough history to recover offer/listing transitions after a brief
// indexer outage. A 500-ledger overlap can miss them when the indexer is
// restarted after more than ~40 minutes on Testnet.
const eventOverlapLedgers = Math.max(1, Number(process.env.STELLAR_INDEXER_EVENT_OVERLAP_LEDGERS ?? 10_000))
let lastRun: { startedAt: string; latestLedger?: number; indexed: number; error?: string } = { startedAt: new Date().toISOString(), indexed: 0 }
let running = false

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) })
  const body = await response.json() as { result?: any; error?: { message?: string } }
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `Soroban RPC ${method} failed`)
  return body.result
}

/** Build the shared feed projection from a confirmed on-chain mint, even when
 * the browser that submitted it never reaches /api/nfts/mint. */
async function projectMintMetadata(contractId: string, tokenId: number, minter: string) {
  const server = new StellarSdk.rpc.Server(rpcUrl)
  const source = await server.getAccount(minter)
  const transaction = new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  }).addOperation(new StellarSdk.Contract(contractId).call('token_uri', StellarSdk.nativeToScVal(tokenId, { type: 'u32' }))).setTimeout(60).build()
  const simulation = await server.simulateTransaction(transaction)
  if ('error' in simulation) throw new Error(`token_uri simulation failed: ${simulation.error}`)
  const retval = simulation.result?.retval
  if (!retval) throw new Error(`Could not read token_uri for ${contractId} #${tokenId}`)
  const uriValue = typeof retval === 'string' ? decode(retval) : StellarSdk.scValToNative(retval)
  const metadataUri = Buffer.from(uriValue as Uint8Array).toString('utf8')
  const metadataUrl = new URL(metadataUri)
  // Metadata is user-controlled on chain. Only fetch the public storage host
  // used by this app, with redirects disabled to prevent server-side requests
  // to arbitrary hosts.
  if (metadataUrl.protocol !== 'https:' || !metadataUrl.hostname.endsWith('.r2.dev') || !metadataUrl.pathname.includes('/nftgram/metadata/')) {
    throw new Error(`Unsupported metadata host for ${contractId} #${tokenId}`)
  }
  const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(8000), redirect: 'error' })
  if (!response.ok) throw new Error(`Metadata fetch returned ${response.status} for ${contractId} #${tokenId}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length === 0 || body.length > 64 * 1024) throw new Error(`Metadata size is invalid for ${contractId} #${tokenId}`)
  const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>
  const name = typeof json.name === 'string' ? json.name.trim().slice(0, 160) : ''
  const image = typeof json.image === 'string' ? json.image.trim().slice(0, 1024) : ''
  if (!name || !/^https:\/\//i.test(image)) throw new Error(`Metadata fields are invalid for ${contractId} #${tokenId}`)
  const segments = metadataUrl.pathname.split('/').filter(Boolean)
  const metadataIndex = segments.indexOf('metadata')
  const scope = metadataIndex >= 0 ? segments[metadataIndex + 1] : ''
  if (!scope || !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(scope)) throw new Error(`Metadata scope is invalid for ${contractId} #${tokenId}`)
  const collectionId = scope.startsWith('personal-') ? null : scope.toLowerCase()
  const attributes = Array.isArray(json.attributes) ? json.attributes : []
  const animationUrl = typeof json.animation_url === 'string' ? json.animation_url.slice(0, 1024) : null
  const description = typeof json.description === 'string' ? json.description.slice(0, 2000) : ''
  const objectKey = metadataUrl.pathname.replace(/^\//, '').slice(0, 512)
  const sha256 = createHash('sha256').update(body).digest('hex')

  await query(
    `INSERT INTO creator_nft_metadata (metadata_uri, collection_id, creator_wallet, object_key, sha256, bytes, name, description, image, animation_url, attributes, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (metadata_uri) DO NOTHING`,
    // Metadata discovered from arbitrary contracts is not treated as a
    // StellaNova-issued provenance record, even if it contains a similarly
    // named JSON property. Internal creator metadata is inserted at upload.
    [metadataUri, scope.toLowerCase(), null, objectKey, sha256, body.length, name, description, image, animationUrl, attributes, {}],
  )
  await query(
    `INSERT INTO nft_mints (contract_id, token_id, minter, collection_id, title, image, animation_url, price_xlm, metadata_uri, stage_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
     ON CONFLICT (contract_id, token_id) DO UPDATE SET
       collection_id=EXCLUDED.collection_id, title=EXCLUDED.title, image=EXCLUDED.image,
       animation_url=EXCLUDED.animation_url, metadata_uri=EXCLUDED.metadata_uri
     WHERE nft_mints.minter = EXCLUDED.minter`,
    [contractId, tokenId, minter, collectionId, name, image, animationUrl, metadataUri],
  )
  if (collectionId) {
    await query(
      'INSERT INTO token_collections (contract_id, token_id, collection_id) VALUES (?, ?, ?) ON CONFLICT (contract_id, token_id) DO UPDATE SET collection_id=EXCLUDED.collection_id',
      [contractId, tokenId, collectionId],
    )
  }
}

function decode(value: string | undefined) {
  if (!value) return null
  try { return StellarSdk.scValToNative(StellarSdk.xdr.ScVal.fromXDR(value, 'base64')) } catch { return null }
}

let sendingExpiryReminders = false

/** Email the buyer after expiry; escrow remains on-chain until they cancel. */
export async function sendOfferExpiryReminders() {
  if (sendingExpiryReminders || !mailConfigured()) return
  sendingExpiryReminders = true
  try {
    await ensureSchema()
    const now = Math.floor(Date.now() / 1000)
    const due = await query<{ offer_id: number; buyer: string; nft_contract: string; token_id: number }[]>(
      `SELECT offer_id, buyer, nft_contract, token_id FROM marketplace_offers
       WHERE contract_id = ? AND active = TRUE AND expiry_reminder_sent_at IS NULL AND expires_at <= ?
       ORDER BY expires_at ASC LIMIT 50`,
      [marketplaceId, now],
    )
    for (const offer of due) {
      const title = await resolveNftTitle(offer.nft_contract, offer.token_id)
      const nftUrl = nftDetailUrl(offer.nft_contract, offer.token_id)
      const message = `Your offer for “${title}” expired after 73 hours. It can no longer be accepted, but the funds are still held in escrow. Cancel the offer to return them to your wallet.\n\nToken #${offer.token_id} · Offer #${offer.offer_id}`
      const delivered = await emailWallet(offer.buyer, `Offer expired · ${title}`, message, nftUrl)
      if (delivered) {
        await notifyWallet(offer.buyer, 'offer_expired', 'Your offer expired', `Offer #${offer.offer_id} expired. Cancel it to reclaim escrow; funds are not returned automatically.`)
        await query('UPDATE marketplace_offers SET expiry_reminder_sent_at = now() WHERE contract_id = ? AND offer_id = ? AND expiry_reminder_sent_at IS NULL', [marketplaceId, offer.offer_id])
      }
    }
  } finally {
    sendingExpiryReminders = false
  }
}

// JSON.stringify throws on BigInt (XLM i128 amounts decode as BigInt).
// Serialize BigInt values as strings so event payloads survive JSONB storage.
function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
}

function formatOfferAmount(value: unknown): string {
  try {
    const amount = BigInt(String(value))
    const whole = amount / 10_000_000n
    const fraction = (amount % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
    return fraction ? `${whole}.${fraction}` : String(whole)
  } catch { return 'an amount of' }
}

// Stable, short, unique key derived from the event for dedup. Keeps rows
// unique while staying well under the VARCHAR(255) event_key column limit.
function eventKeyFrom(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 64)
}

async function activateReferral(wallet: unknown, kind: 'mint' | 'collect') {
  const address = String(wallet ?? '')
  if (!/^G[A-Z2-7]{55}$/.test(address)) return
  await query('UPDATE referrals SET activated_at = now(), activation_kind = ? WHERE LOWER(referred_wallet) = LOWER(?) AND activated_at IS NULL', [kind, address])
}

async function applyEvent(event: any) {
  const contractId = String(event.contractId ?? '')
  const txHash = String(event.txHash ?? '')
  const ledger = Number(event.ledger ?? 0)
  const topics = Array.isArray(event.topic) ? event.topic.map((topic: string) => decode(topic)) : []
  const value = decode(event.value)
  const eventType = String(topics[0] ?? value?.[0] ?? 'unknown')
  const data = Array.isArray(value) ? value : Array.isArray(value?.values) ? value.values : value
  const eventKey = eventKeyFrom(`${txHash}:${safeStringify(topics)}:${safeStringify(value)}`)
  const existing = await query('SELECT 1 FROM marketplace_events WHERE event_key = ? LIMIT 1', [eventKey])
  if (existing.length) return false

  if (contractId === marketplaceId && Array.isArray(data)) {
    if (eventType === 'list' && data.length >= 7) {
      await query(
        'INSERT INTO marketplace_listings (listing_id, contract_id, seller, nft_contract, token_id, payment_token, price, expires_at, active, ledger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?) ON CONFLICT (contract_id, listing_id) DO UPDATE SET active=TRUE, price=EXCLUDED.price, expires_at=EXCLUDED.expires_at, ledger=EXCLUDED.ledger',
        [data[0], contractId, data[1], data[2], data[3], data[4], data[5], data[6], ledger],
      )
    } else if (eventType === 'list_u' && data.length >= 7) {
      await query('UPDATE marketplace_listings SET payment_token=?, price=?, expires_at=?, ledger=?, updated_at=now() WHERE contract_id=? AND listing_id=? AND active=TRUE', [data[4], data[5], data[6], ledger, contractId, data[0]])
    } else if (eventType === 'sale' && data.length >= 6) {
      await query('UPDATE marketplace_listings SET active=FALSE, ledger=? WHERE contract_id=? AND listing_id=?', [ledger, contractId, data[0]])
      await upsertOwnership(data[3], data[4], data[1], ledger)
      await activateReferral(data[1], 'collect')
      // data: (listing_id, buyer, seller, nft_contract, token_id, price)
      await notifyWallet(data[1], 'sale', 'You collected an NFT', `Token #${data[4]} is now in your wallet.`)
    } else if (eventType === 'cancel' && data.length >= 1) {
      await query('UPDATE marketplace_listings SET active=FALSE, ledger=? WHERE contract_id=? AND listing_id=?', [ledger, contractId, data[0]])
    } else if (eventType === 'exp_l' && data.length >= 1) {
      // Permissionless expiry reclaim closed an expired listing.
      await query('UPDATE marketplace_listings SET active=FALSE, ledger=? WHERE contract_id=? AND listing_id=?', [ledger, contractId, data[0]])
    } else if (eventType === 'offer' && data.length >= 7) {
      await query(
        'INSERT INTO marketplace_offers (offer_id, buyer, nft_contract, token_id, payment_token, amount, expires_at, active, ledger, contract_id) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?) ON CONFLICT (contract_id, offer_id) DO UPDATE SET active=TRUE, amount=EXCLUDED.amount, expires_at=EXCLUDED.expires_at, ledger=EXCLUDED.ledger',
        [data[0], data[1], data[2], data[3], data[4], data[5], data[6], ledger, contractId],
      )
      // data: (offer_id, buyer, nft_contract, token_id, payment_token, amount, expires_at)
      // Notify the current owner that they received an offer.
      const owner = await resolveTokenOwner(data[2], data[3])
      if (owner) {
        const title = await resolveNftTitle(data[2], Number(data[3]))
        const nftPath = `/nft/minted-${String(data[2]).toLowerCase()}-${data[3]}`
        const appUrl = (process.env.PUBLIC_APP_URL ?? process.env.APP_URL ?? 'https://stellanova-fawn.vercel.app').replace(/\/$/, '')
        const nftUrl = new URL(nftPath, appUrl).toString()
        const body = `A buyer made an offer of ${formatOfferAmount(data[5])} XLM on “${title}” (Token #${data[3]}).\n\nView the NFT and review the offer: ${nftUrl}`
        await notifyWallet(owner, 'offer', 'You received an offer', body)
        await emailWallet(owner, `New offer for ${title}`, body, nftUrl)
      }
    } else if (eventType === 'c_off' && data.length >= 7) {
      await query('INSERT INTO marketplace_collection_offers (offer_id, contract_id, buyer, nft_contract, collection_scope, payment_token, amount, expires_at, active, ledger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?) ON CONFLICT (contract_id, offer_id) DO UPDATE SET buyer=EXCLUDED.buyer, nft_contract=EXCLUDED.nft_contract, collection_scope=EXCLUDED.collection_scope, payment_token=EXCLUDED.payment_token, amount=EXCLUDED.amount, expires_at=EXCLUDED.expires_at, active=TRUE, ledger=EXCLUDED.ledger, updated_at=now()', [data[0], contractId, data[1], data[2], data[3], data[4], data[5], data[6], ledger])
    } else if (eventType === 'c_sale' && data.length >= 6) {
      await query('UPDATE marketplace_collection_offers SET active=FALSE, ledger=?, updated_at=now() WHERE contract_id=? AND offer_id=?', [ledger, contractId, data[0]])
      await upsertOwnership(data[3], data[4], data[1], ledger)
      await activateReferral(data[1], 'collect')
    } else if ((eventType === 'c_c' || eventType === 'c_exp') && data.length >= 1) {
      await query('UPDATE marketplace_collection_offers SET active=FALSE, ledger=?, updated_at=now() WHERE contract_id=? AND offer_id=?', [ledger, contractId, data[0]])
    } else if (eventType === 't_off' && data.length >= 9) {
      await query('INSERT INTO marketplace_trait_offers (offer_id, contract_id, buyer, nft_contract, collection_scope, trait_type, trait_value, payment_token, amount, expires_at, active, ledger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?) ON CONFLICT (contract_id, offer_id) DO UPDATE SET buyer=EXCLUDED.buyer, nft_contract=EXCLUDED.nft_contract, collection_scope=EXCLUDED.collection_scope, trait_type=EXCLUDED.trait_type, trait_value=EXCLUDED.trait_value, payment_token=EXCLUDED.payment_token, amount=EXCLUDED.amount, expires_at=EXCLUDED.expires_at, active=TRUE, ledger=EXCLUDED.ledger, updated_at=now()', [data[0], contractId, data[1], data[2], data[3], data[4], data[5], data[6], data[7], data[8], ledger])
    } else if (eventType === 't_sale' && data.length >= 6) {
      await query('UPDATE marketplace_trait_offers SET active=FALSE, ledger=?, updated_at=now() WHERE contract_id=? AND offer_id=?', [ledger, contractId, data[0]])
      await upsertOwnership(data[3], data[4], data[1], ledger)
      await activateReferral(data[1], 'collect')
    } else if ((eventType === 't_c' || eventType === 't_exp') && data.length >= 1) {
      await query('UPDATE marketplace_trait_offers SET active=FALSE, ledger=?, updated_at=now() WHERE contract_id=? AND offer_id=?', [ledger, contractId, data[0]])
    } else if ((eventType === 'offer_c' || eventType === 'offer_cancel') && data.length >= 1) {
      await query('UPDATE marketplace_offers SET active=FALSE, ledger=? WHERE contract_id=? AND offer_id=?', [ledger, contractId, data[0]])
    } else if (eventType === 'offer_r' && Array.isArray(data) && data.length >= 3) {
      const offer = await query<{ nft_contract: string; token_id: number; buyer: string }[]>('SELECT nft_contract, token_id, buyer FROM marketplace_offers WHERE contract_id=? AND offer_id=? LIMIT 1', [contractId, data[0]])
      await query('UPDATE marketplace_offers SET active=FALSE, ledger=? WHERE contract_id=? AND offer_id=?', [ledger, contractId, data[0]])
      if (offer[0]) {
        const title = await resolveNftTitle(offer[0].nft_contract, offer[0].token_id)
        const body = `The owner cancelled your offer for “${title}”. Your escrow was refunded on Stellar.\n\nToken #${offer[0].token_id} · Offer #${data[0]}`
        const nftUrl = nftDetailUrl(offer[0].nft_contract, offer[0].token_id)
        await notifyWallet(offer[0].buyer || data[2], 'offer_cancelled', 'An offer was cancelled', body)
        await emailWallet(offer[0].buyer || data[2], `Offer cancelled · ${title}`, body, nftUrl)
      }
    } else if (eventType === 'exp_o' && data.length >= 1) {
      // Permissionless expiry reclaim refunded an expired offer.
      const offer = await query<{ buyer: string; nft_contract: string; token_id: number }[]>(
        'SELECT buyer, nft_contract, token_id FROM marketplace_offers WHERE contract_id=? AND offer_id=? LIMIT 1', [contractId, data[0]],
      )
      await query('UPDATE marketplace_offers SET active=FALSE, ledger=? WHERE contract_id=? AND offer_id=?', [ledger, contractId, data[0]])
      if (offer[0]) {
        const title = await resolveNftTitle(offer[0].nft_contract, offer[0].token_id)
        const message = `Your offer for “${title}” expired and the escrow was refunded.\n\nToken #${offer[0].token_id} · Offer #${data[0]}`
        await notifyWallet(offer[0].buyer, 'offer_expired', 'Your offer expired', message)
        await emailWallet(offer[0].buyer, `Offer expired · ${title}`, message, nftDetailUrl(offer[0].nft_contract, offer[0].token_id))
        const owner = await resolveTokenOwner(offer[0].nft_contract, offer[0].token_id)
        if (owner) await notifyWallet(owner, 'offer_expired', 'An offer expired', `Offer #${data[0]} on token #${offer[0].token_id} expired.`)
      }
    } else if ((eventType === 'offer_s' || eventType === 'offer_sale') && data.length >= 6) {
      await query('UPDATE marketplace_offers SET active=FALSE, ledger=? WHERE contract_id=? AND offer_id=?', [ledger, contractId, data[0]])
      await upsertOwnership(data[3], data[4], data[1], ledger)
      // data: (offer_id, buyer, seller, nft_contract, token_id, amount)
      const title = await resolveNftTitle(data[3], Number(data[4]))
      const nftUrl = nftDetailUrl(data[3], data[4])
      const body = `Your offer for “${title}” was accepted. You now own this NFT. The transfer is confirmed on Stellar.`
      await notifyWallet(data[1], 'offer_sale', 'Your offer was accepted', body)
      await emailWallet(data[1], `Offer accepted · ${title}`, `${body}\n\nToken #${data[4]}`, nftUrl)
    } else if (eventType === 'auction' && data.length >= 9) {
      await query(
        'INSERT INTO marketplace_auctions (auction_id, contract_id, seller, nft_contract, token_id, payment_token, reserve_price, min_increment, highest_bid, highest_bidder, starts_at, ends_at, active, ledger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, TRUE, ?) ON CONFLICT (contract_id, auction_id) DO UPDATE SET seller=EXCLUDED.seller, nft_contract=EXCLUDED.nft_contract, token_id=EXCLUDED.token_id, payment_token=EXCLUDED.payment_token, reserve_price=EXCLUDED.reserve_price, min_increment=EXCLUDED.min_increment, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, active=TRUE, ledger=EXCLUDED.ledger, updated_at=now()',
        [data[0], contractId, data[1], data[2], data[3], data[4], data[5], data[6], data[7], data[8], ledger],
      )
    } else if (eventType === 'bid' && data.length >= 3) {
      // A new bid immediately refunds the previous bidder's escrow in the
      // contract. Read the old projection before updating it so that person
      // gets a useful notification instead of silently losing the lead.
      const previous = await query<{ highest_bidder: string | null; nft_contract: string; token_id: number; highest_bid: string }[]>(
        'SELECT highest_bidder, nft_contract, token_id, highest_bid FROM marketplace_auctions WHERE contract_id=? AND auction_id=? AND active=TRUE LIMIT 1',
        [contractId, data[0]],
      )
      await query('UPDATE marketplace_auctions SET highest_bidder=?, highest_bid=?, ledger=?, updated_at=now() WHERE contract_id=? AND auction_id=? AND active=TRUE', [data[1], data[2], ledger, contractId, data[0]])
      const auction = previous[0]
      if (auction?.highest_bidder && auction.highest_bidder !== data[1]) {
        const title = await resolveNftTitle(auction.nft_contract, Number(auction.token_id))
        const body = `Your bid of ${formatOfferAmount(auction.highest_bid)} XLM for “${title}” was exceeded. The contract refunded your escrow automatically. You can place another bid if the auction is still live.`
        await notifyWallet(auction.highest_bidder, 'auction_outbid', 'You were outbid', body)
        await emailWallet(auction.highest_bidder, `You were outbid · ${title}`, body, nftDetailUrl(auction.nft_contract, auction.token_id))
      }
    } else if ((eventType === 'auc_c' || eventType === 'auc_e') && data.length >= 1) {
      await query('UPDATE marketplace_auctions SET active=FALSE, ledger=?, updated_at=now() WHERE contract_id=? AND auction_id=?', [ledger, contractId, data[0]])
    } else if ((eventType === 'auc_s' || eventType === 'auction_sale') && data.length >= 6) {
      await query('UPDATE marketplace_auctions SET active=FALSE, highest_bidder=?, highest_bid=?, ledger=?, updated_at=now() WHERE contract_id=? AND auction_id=?', [data[1], data[5], ledger, contractId, data[0]])
      await upsertOwnership(data[3], data[4], data[1], ledger)
      // data: (auction_id, winner, seller, nft_contract, token_id, highest_bid)
      const title = await resolveNftTitle(data[3], Number(data[4]))
      const amount = `${formatOfferAmount(data[5])} XLM`
      const nftUrl = nftDetailUrl(data[3], data[4])
      const winnerBody = `You won “${title}” for ${amount}. The NFT transfer is confirmed on Stellar.`
      await notifyWallet(data[1], 'auction_sale', 'You won the auction', winnerBody)
      await emailWallet(data[1], `Auction won · ${title}`, winnerBody, nftUrl)
      const sellerBody = `Your auction for “${title}” ended with a sale of ${amount}. Proceeds were transferred to your wallet on Stellar.`
      await notifyWallet(data[2], 'auction_sale', 'Your auction sold', sellerBody)
      await emailWallet(data[2], `Auction sold · ${title}`, sellerBody, nftUrl)
    }
  }

  // NFT contract: track ownership from mint & transfer events.
  // SEP-50 non-fungible transfer event shape:
  //   topics: [transfer, from (Address), to (Address)]
  //   data/value: [token_id (u32)]
  // For a mint, `from` is the null address and `to` is the new owner.
  if (nftContractIds.has(contractId) && eventType === 'stage_mint' && Array.isArray(data)) {
    const stageId = Number(topics[1])
    const wallet = String(topics[2] ?? '')
    const hasEditionStart = Array.isArray(data[1])
    const editionStart = hasEditionStart ? Number(data[0]) : 0
    const rawTokenIds = hasEditionStart ? data[1] : data
    // New contract versions append exact paid stroops to the mint event.
    // Older events have no third value; leave those null instead of guessing
    // from a stage price that may have changed since the mint.
    const paidStroops = hasEditionStart && data.length >= 3 && /^\d+$/.test(String(data[2]))
      ? String(data[2])
      : null
    const tokenIds = rawTokenIds.map((tokenId: unknown) => Number(tokenId)).filter((tokenId: number) => Number.isSafeInteger(tokenId) && tokenId >= 0)
    if (Number.isSafeInteger(stageId) && stageId >= 0 && /^G[A-Z2-7]{55}$/.test(wallet) && tokenIds.length) {
      await query(
        'INSERT INTO stage_mint_events (contract_id, tx_hash, stage_id, wallet, token_ids, ledger, edition_start, paid_stroops) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (contract_id, tx_hash, stage_id) DO NOTHING',
        [contractId, txHash, stageId, wallet, tokenIds, ledger, Number.isSafeInteger(editionStart) && editionStart >= 0 ? editionStart : 0, paidStroops],
      )
      await activateReferral(wallet, 'mint')
    }
  }
  if (nftContractIds.has(contractId) && (eventType === 'transfer' || eventType === 'mint')) {
    const tokenId = Array.isArray(data) ? data[0] : data
    const to = eventType === 'mint' ? topics[1] : topics[2]
    if (tokenId !== undefined && to !== undefined) {
      await upsertOwnership(contractId, tokenId, to, ledger)
      if (eventType === 'mint') {
        await query('INSERT INTO verified_nft_mints (contract_id, token_id, minter, tx_hash, ledger) VALUES (?, ?, ?, ?, ?) ON CONFLICT (contract_id, token_id) DO NOTHING', [contractId, tokenId, to, txHash, ledger])
        await activateReferral(to, 'mint')
        await fanoutDropNotification(contractId, tokenId)
        await notifyWallet(to, 'drop', 'New drop', `You received token #${tokenId}.`)
      }
    }
  }
  // Write the dedupe marker only after all projections succeed so a failed
  // update is retried on the next poll instead of being silently skipped.
  await query('INSERT INTO marketplace_events (event_key, event_type, contract_id, tx_hash, ledger, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (event_key) DO NOTHING', [eventKey, eventType, contractId, txHash, ledger, safeStringify({ topics, value, event })])
  return true
}

async function upsertOwnership(contractId: unknown, tokenId: unknown, ownerAddress: unknown, ledger: number) {
  await query(
    'INSERT INTO nft_ownership (contract_id, token_id, owner_address, ledger) VALUES (?, ?, ?, ?) ON CONFLICT (contract_id, token_id) DO UPDATE SET owner_address=EXCLUDED.owner_address, ledger=EXCLUDED.ledger',
    [contractId, tokenId, ownerAddress, ledger],
  )
}

/**
 * Write a notification into a wallet's inbox. Called from the indexer for
 * marketplace settlement events so trading activity drives the same
 * notification feed as social activity. Dedup is guaranteed by the caller:
 * the surrounding `marketplace_events` row is only inserted once per event.
 */
async function notifyWallet(wallet: unknown, kind: string, title: string, body: string) {
  if (typeof wallet !== 'string' || !/^G[A-Z2-7]{55}$/.test(wallet)) return
  await notifyUser(wallet, kind, title, body)
}

async function resolveNftTitle(contractId: unknown, tokenId: number): Promise<string> {
  const rows = await query<{ title: string | null }[]>(
    `SELECT COALESCE(NULLIF(m.title, ''), NULLIF(n.name, ''), NULLIF(s.metadata_name, ''), NULLIF(c.name, '')) AS title
     FROM (SELECT ?::varchar AS contract_id, ?::int AS token_id) ref
     LEFT JOIN nft_mints m ON LOWER(m.contract_id) = LOWER(ref.contract_id) AND m.token_id = ref.token_id
     LEFT JOIN canonical_metadata cm ON LOWER(cm.contract_id) = LOWER(ref.contract_id) AND cm.token_id = ref.token_id
     LEFT JOIN creator_nft_metadata n ON n.metadata_uri = COALESCE(m.metadata_uri, cm.metadata_uri)
     LEFT JOIN mint_stages s ON s.id = m.stage_id
     LEFT JOIN collections c ON c.slug = COALESCE(m.collection_id, n.collection_id)`,
    [String(contractId), tokenId],
  )
  return rows[0]?.title?.trim() || `NFT #${tokenId}`
}

async function emailWallet(wallet: unknown, subject: string, body: string, actionUrl?: string) {
  if (typeof wallet !== 'string' || !/^G[A-Z2-7]{55}$/.test(wallet) || !mailConfigured()) return false
  const profile = await query<{ email: string | null }[]>('SELECT email FROM user_profiles WHERE LOWER(wallet_address) = LOWER(?) LIMIT 1', [wallet])
  const email = profile[0]?.email?.trim()
  if (!email) return false
  const emailContent = marketplaceEmail(subject, body, actionUrl, 'View NFT on StellaNova')
  return (await sendMail({ to: email, subject, ...emailContent })).sent
}

function nftDetailUrl(contractId: unknown, tokenId: unknown) {
  const appUrl = (process.env.PUBLIC_APP_URL ?? process.env.APP_URL ?? 'https://stellanova-fawn.vercel.app').replace(/\/$/, '')
  const nftId = `minted-${String(contractId).toLowerCase()}-${Number(tokenId)}`
  return new URL(`/nft/${encodeURIComponent(nftId)}`, appUrl).toString()
}

// Resolve the current owner of a token for “offer received” notifications:
// prefer the seller of an active listing for that token, falling back to the
// latest indexed ownership record.
async function resolveTokenOwner(nftContract: unknown, tokenId: unknown): Promise<string | null> {
  const listing = await query<{ seller: string }[]>(
    'SELECT seller FROM marketplace_listings WHERE nft_contract = ? AND token_id = ? AND active = TRUE ORDER BY ledger DESC LIMIT 1',
    [nftContract, tokenId],
  )
  if (listing.length && listing[0].seller) return listing[0].seller
  const ownership = await query<{ owner_address: string }[]>(
    'SELECT owner_address FROM nft_ownership WHERE contract_id = ? AND token_id = ? ORDER BY ledger DESC LIMIT 1',
    [nftContract, tokenId],
  )
  return ownership.length ? ownership[0].owner_address : null
}

// Fan out a “new drop” notification to every collector subscribed to the
// collection that a freshly-minted token belongs to. Dedup is guaranteed at the
// event level (each mint writes one marketplace_events row).
async function fanoutDropNotification(contractId: string, tokenId: unknown) {
  const registry = await query<{ collection_id: string }[]>(
    `SELECT collection_id FROM token_collections WHERE LOWER(contract_id) = LOWER(?) AND token_id = ?
     UNION SELECT collection_id FROM nft_mints WHERE LOWER(contract_id) = LOWER(?) AND token_id = ? AND collection_id IS NOT NULL
     LIMIT 1`,
    [contractId, tokenId, contractId, tokenId],
  )
  if (!registry.length) return
  const collectionId = registry[0].collection_id
  const collection = await query<{ owner_wallet: string; name: string }[]>(
    'SELECT owner_wallet, name FROM collections WHERE slug = ? LIMIT 1', [collectionId],
  )
  if (collection.length) {
    await notifyUser(
      collection[0].owner_wallet,
      'collection_mint',
      'Your collection received a mint',
      `${collection[0].name} just received a new mint (token #${tokenId}).`,
      `/collection/${encodeURIComponent(collectionId)}`,
    )
  }
  const subscribers = await query<{ wallet_address: string }[]>(
    'SELECT wallet_address FROM collection_subscriptions WHERE collection_id = ?',
    [collectionId],
  )
  for (const subscriber of subscribers) {
    if (subscriber.wallet_address.toLowerCase() === collection[0]?.owner_wallet.toLowerCase()) continue
    await notifyUser(subscriber.wallet_address, 'drop', `New mint in ${collection[0]?.name ?? collectionId}`, `Token #${tokenId} just minted in ${collection[0]?.name ?? collectionId}.`, `/collection/${encodeURIComponent(collectionId)}`)
  }
}

export function indexerStatus() {
  return { rpcUrl, marketplaceId, nftId, nftContractIds: [...nftContractIds], cursor, lastRun }
}

export async function runIndexerOnce() {
  if (running || !marketplaceId) return
  running = true
  lastRun = { startedAt: new Date().toISOString(), indexed: 0 }
  try {
    await ensureSchema()
    const registeredContracts = await query<{ contract_id: string }[]>('SELECT contract_id FROM nft_contract_registry WHERE network = ?', ['TESTNET'])
    nftContractIds = new Set([...(nftId ? [nftId] : []), ...registeredContracts.map((row) => row.contract_id)])
    const latest = await rpc('getLatestLedger')
    const latestLedger = Number(latest.sequence)
    const sorobanServer = new StellarSdk.rpc.Server(rpcUrl)
    // A configured start ledger is only the bootstrap position. Once the
    // indexer has persisted progress, always resume from that checkpoint;
    // otherwise every server restart replays from the original env value and
    // newly minted NFTs can remain invisible while the indexer catches up.
    const saved = await query<{ next_ledger: number }[]>('SELECT next_ledger FROM indexer_state WHERE name = ?', ['stellar-events'])
    if (saved.length) {
      cursor = Math.max(1, Number(saved[0].next_ledger) - eventOverlapLedgers)
    } else {
      cursor = cursor || Math.max(1, latestLedger - 1000)
      await query('INSERT INTO indexer_state (name, next_ledger) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', ['stellar-events', cursor])
    }
    // Soroban RPC only keeps a finite event history. If this function was not
    // invoked for long enough, replaying the persisted cursor can be rejected
    // forever with "startLedger must be within the ledger range". Resume from
    // a point safely inside the currently retained window; recent marketplace
    // events (including offers) will then be indexed and the checkpoint moves
    // forward again.
    cursor = Math.max(cursor, latestLedger - 120_000)
    const filters = [{ type: 'contract', contractIds: [marketplaceId, ...nftContractIds] }]
    // The RPC limits a single scan window. When resuming after downtime, scan
    // several windows per pass so recent mints don't wait minutes in a backlog.
    const maxBatchesPerRun = 25
    for (let batch = 0; batch < maxBatchesPerRun && cursor <= latestLedger; batch += 1) {
      const endLedger = Math.min(latestLedger, cursor + 1000)
      let pagingToken: string | undefined
      let pageSize = 0
      do {
        const result = await rpc('getEvents', pagingToken
          ? { cursor: pagingToken, filters, limit: 100 }
          : { startLedger: cursor, endLedger, filters, limit: 100 })
        for (const event of result.events ?? []) {
          const applied = await withTransaction(() => applyEvent(event))
          if (applied) lastRun.indexed += 1
        }
        pageSize = (result.events ?? []).length
        pagingToken = pageSize === 100 ? result.cursor : undefined
      } while (pagingToken)
      cursor = endLedger + 1
      await query('INSERT INTO indexer_state (name, next_ledger, updated_at) VALUES (?, ?, now()) ON CONFLICT (name) DO UPDATE SET next_ledger=GREATEST(indexer_state.next_ledger, EXCLUDED.next_ledger), updated_at=now()', ['stellar-events', cursor])
    }
    // Older deployed marketplace contracts don't emit an event when an
    // ended auction with no bids is settled. Reconcile those rows by reading
    // the contract's existing auction state; this is read-only and needs no
    // contract upgrade or replacement contract ID.
    const endedAuctions = await query<{ auction_id: number; seller: string }[]>(
      'SELECT auction_id, seller FROM marketplace_auctions WHERE contract_id=? AND active=TRUE AND ends_at<=? ORDER BY ends_at ASC LIMIT 50',
      [marketplaceId, latestLedger],
    )
    for (const auction of endedAuctions) {
      try {
        const source = await sorobanServer.getAccount(auction.seller)
        const transaction = new StellarSdk.TransactionBuilder(source, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: StellarSdk.Networks.TESTNET,
        }).addOperation(new StellarSdk.Contract(marketplaceId).call(
          'get_auction',
          StellarSdk.nativeToScVal(Number(auction.auction_id), { type: 'u32' }),
        ) as never).setTimeout(60).build()
        const simulation = await sorobanServer.simulateTransaction(transaction)
        if (StellarSdk.rpc.Api.isSimulationError(simulation)) continue
        const state = simulation.result?.retval ? StellarSdk.scValToNative(simulation.result.retval) as { active?: unknown } : null
        if (state?.active === false) {
          await query('UPDATE marketplace_auctions SET active=FALSE, ledger=?, updated_at=now() WHERE contract_id=? AND auction_id=? AND active=TRUE', [latestLedger, marketplaceId, auction.auction_id])
        }
      } catch {
        // A transient RPC error should not stop event indexing for the ledger.
      }
    }
    // Project any confirmed mint events that do not yet have a feed row. This
    // also repairs old events already marked indexed and makes feed visibility
    // independent of the originating browser's local retry queue.
    const pendingMints = await query<{ contract_id: string; token_id: number; minter: string }[]>(
      `SELECT v.contract_id, v.token_id, v.minter
       FROM verified_nft_mints v
       LEFT JOIN nft_mints m ON m.contract_id = v.contract_id AND m.token_id = v.token_id
       WHERE m.contract_id IS NULL
       ORDER BY v.ledger DESC
       LIMIT 25`,
    )
    for (const mint of pendingMints) {
      try { await projectMintMetadata(mint.contract_id, Number(mint.token_id), mint.minter) }
      catch (error) {
        lastRun.error = error instanceof Error ? `Mint metadata sync: ${error.message}` : 'Mint metadata sync failed'
      }
    }
    lastRun.latestLedger = latestLedger
    await sendOfferExpiryReminders()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Indexer failed'
    // RPC nodes can change their retained event range. If a persisted cursor
    // falls behind that moving floor, persist the advertised minimum so the
    // next invocation resumes inside the valid range instead of retrying the
    // same permanently invalid cursor.
    const availableFrom = message.match(/ledger range:\s*(\d+)\s*[-–]\s*(\d+)/i)
    if (availableFrom) {
      const floor = Number(availableFrom[1])
      if (Number.isSafeInteger(floor) && floor > cursor) {
        cursor = floor
        try {
          await query('INSERT INTO indexer_state (name, next_ledger, updated_at) VALUES (?, ?, now()) ON CONFLICT (name) DO UPDATE SET next_ledger=GREATEST(indexer_state.next_ledger, EXCLUDED.next_ledger), updated_at=now()', ['stellar-events', floor])
        } catch { /* The next request will retry against the in-memory floor. */ }
        lastRun.error = `RPC event history starts at ledger ${floor}; resumed from the available range.`
      } else lastRun.error = message
    } else lastRun.error = message
  } finally {
    running = false
  }
}

/** Reconcile this wallet's cached offers and NFT owners against Soroban. This
 * repairs stale UI state when an offer was cancelled/accepted outside this app
 * or its event aged out of the indexer's replay window. */
export async function reconcileMarketplaceStateForWallet(wallet: string) {
  if (!marketplaceId) return
  const offers = await query<{ offer_id: number; contract_id: string; nft_contract: string; token_id: number }[]>(
    `SELECT DISTINCT o.offer_id, o.contract_id, o.nft_contract, o.token_id
     FROM marketplace_offers o
     LEFT JOIN nft_ownership n ON n.contract_id = o.nft_contract AND n.token_id = o.token_id
     WHERE o.contract_id = ? AND o.active = TRUE AND (o.buyer = ? OR n.owner_address = ?)
     ORDER BY o.offer_id DESC LIMIT 100`,
    [marketplaceId, wallet, wallet],
  )
  if (!offers.length) return

  const server = new StellarSdk.rpc.Server(rpcUrl)
  const latest = await rpc('getLatestLedger')
  const ledger = Number(latest.sequence)
  const source = await server.getAccount(wallet)
  const transaction = (contractId: string, method: string, args: StellarSdk.xdr.ScVal[]) => new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  }).addOperation(new StellarSdk.Contract(contractId).call(method, ...args) as never).setTimeout(60).build()

  for (const offer of offers) {
    try {
      const offerTx = transaction(offer.contract_id, 'get_offer', [StellarSdk.nativeToScVal(offer.offer_id, { type: 'u32' })])
      const offerResult = await server.simulateTransaction(offerTx)
      if (StellarSdk.rpc.Api.isSimulationError(offerResult)) continue
      const offerValue = offerResult.result?.retval ? StellarSdk.scValToNative(offerResult.result.retval) as { active?: boolean; nft_contract?: string; token_id?: number } : null
      if (!offerValue) continue
      if (offerValue.active === false) {
        await query('UPDATE marketplace_offers SET active = FALSE, ledger = ? WHERE contract_id = ? AND offer_id = ? AND active = TRUE', [ledger, offer.contract_id, offer.offer_id])
      }

      const nftContract = offerValue.nft_contract || offer.nft_contract
      const tokenId = offerValue.token_id ?? offer.token_id
      const ownerTx = transaction(nftContract, 'owner_of', [StellarSdk.nativeToScVal(tokenId, { type: 'u32' })])
      const ownerResult = await server.simulateTransaction(ownerTx)
      if (StellarSdk.rpc.Api.isSimulationError(ownerResult) || !ownerResult.result?.retval) continue
      const owner = StellarSdk.scValToNative(ownerResult.result.retval)
      if (typeof owner !== 'string') continue
      await upsertOwnership(nftContract, tokenId, owner, ledger)
    } catch (error) {
      // A single old or malformed offer must not prevent the rest of the
      // wallet's marketplace state from loading.
      lastRun.error = error instanceof Error ? `Offer reconciliation: ${error.message}` : 'Offer reconciliation failed'
    }
  }
}

/** Submit bounded permissionless marketplace cleanup calls with a dedicated
 * funded keeper key. Never use the marketplace admin/deployer key here. */
export async function runMarketplaceKeeper() {
  const keeperSecret = process.env.STELLAR_MARKETPLACE_KEEPER_SECRET
  if (!keeperSecret) throw new Error('Marketplace keeper signer is not configured')
  if ((process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase() !== 'TESTNET') throw new Error('Marketplace keeper is restricted to Stellar Testnet')
  await ensureSchema()
  const server = new StellarSdk.rpc.Server(rpcUrl)
  const keeper = StellarSdk.Keypair.fromSecret(keeperSecret)
  const latest = await rpc('getLatestLedger')
  const ledger = Number(latest.sequence)
  const now = Math.floor(Date.now() / 1000)
  const [listings, offers, collectionOffers, traitOffers, auctions] = await Promise.all([
    query<{ listing_id: number }[]>('SELECT listing_id FROM marketplace_listings WHERE contract_id=? AND active=TRUE AND expires_at<=? ORDER BY expires_at ASC LIMIT 10', [marketplaceId, ledger]),
    query<{ offer_id: number }[]>('SELECT offer_id FROM marketplace_offers WHERE contract_id=? AND active=TRUE AND expires_at<=? ORDER BY expires_at ASC LIMIT 10', [marketplaceId, now]),
    query<{ offer_id: number }[]>('SELECT offer_id FROM marketplace_collection_offers WHERE contract_id=? AND active=TRUE AND expires_at<=? ORDER BY expires_at ASC LIMIT 10', [marketplaceId, now]),
    query<{ offer_id: number }[]>('SELECT offer_id FROM marketplace_trait_offers WHERE contract_id=? AND active=TRUE AND expires_at<=? ORDER BY expires_at ASC LIMIT 10', [marketplaceId, now]),
    query<{ auction_id: number }[]>('SELECT auction_id FROM marketplace_auctions WHERE contract_id=? AND active=TRUE AND ends_at<=? ORDER BY ends_at ASC LIMIT 10', [marketplaceId, ledger]),
  ])
  let submitted = 0
  let failed = 0
  const run = async (method: string, id: number) => {
    try {
      const account = await server.getAccount(keeper.publicKey())
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      }).addOperation(new StellarSdk.Contract(marketplaceId).call(method, StellarSdk.nativeToScVal(id, { type: 'u32' })) as never).setTimeout(60).build()
      const prepared = await server.prepareTransaction(tx)
      prepared.sign(keeper)
      const sent = await server.sendTransaction(prepared)
      if (sent.status === 'ERROR') throw new Error(`RPC rejected ${method}`)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const result = await server.getTransaction(sent.hash)
        if (result.status === 'SUCCESS') { submitted += 1; return }
        if (result.status === 'FAILED') throw new Error(`${method} transaction failed`)
      }
      throw new Error(`${method} confirmation timed out`)
    } catch (error) {
      failed += 1
      lastRun.error = error instanceof Error ? `Marketplace keeper: ${error.message}` : 'Marketplace keeper transaction failed'
    }
  }
  for (const item of listings) await run('expire_listing', Number(item.listing_id))
  for (const item of offers) await run('expire_offer', Number(item.offer_id))
  for (const item of collectionOffers) await run('expire_collection_offer', Number(item.offer_id))
  for (const item of traitOffers) await run('expire_trait_offer', Number(item.offer_id))
  for (const item of auctions) await run('settle_auction', Number(item.auction_id))
  if (submitted) await runIndexerOnce()
  return { latestLedger: ledger, checked: listings.length + offers.length + collectionOffers.length + traitOffers.length + auctions.length, submitted, failed }
}

/** Compare a bounded ownership projection sample with Soroban owner_of state and
 * repair only mismatches from chain truth. Used by the admin reconciliation
 * dashboard and its recovery drill. */
export async function reconcileOwnershipAgainstSoroban(limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)))
  const contractIds = [...nftContractIds]
  if (!contractIds.length) return { checked: 0, mismatches: 0, repaired: 0, failed: 0, latestLedger: null }
  const rows = await query<{ contract_id: string; token_id: number; owner_address: string | null; minter: string; ledger: number }[]>(
    `SELECT v.contract_id, v.token_id, o.owner_address, v.minter, COALESCE(o.ledger, v.ledger) AS ledger
     FROM verified_nft_mints v
     LEFT JOIN nft_ownership o ON LOWER(o.contract_id)=LOWER(v.contract_id) AND o.token_id=v.token_id
     WHERE v.contract_id = ANY(?)
     ORDER BY COALESCE(o.ledger, v.ledger) DESC, v.token_id DESC LIMIT ?`,
    [contractIds, safeLimit],
  )
  const server = new StellarSdk.rpc.Server(rpcUrl)
  const latest = await rpc('getLatestLedger')
  const latestLedger = Number(latest.sequence)
  let mismatches = 0
  let repaired = 0
  let failed = 0
  for (const row of rows) {
    try {
      const source = await server.getAccount(row.owner_address ?? row.minter)
      const tx = new StellarSdk.TransactionBuilder(source, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      }).addOperation(new StellarSdk.Contract(row.contract_id).call('owner_of', StellarSdk.nativeToScVal(row.token_id, { type: 'u32' }))).setTimeout(60).build()
      const simulation = await server.simulateTransaction(tx)
      if (StellarSdk.rpc.Api.isSimulationError(simulation) || !simulation.result?.retval) {
        failed += 1
        continue
      }
      const chainOwner = StellarSdk.scValToNative(simulation.result.retval)
      if (typeof chainOwner !== 'string') {
        failed += 1
        continue
      }
      if (!row.owner_address || chainOwner.toLowerCase() !== row.owner_address.toLowerCase()) {
        mismatches += 1
        await upsertOwnership(row.contract_id, row.token_id, chainOwner, latestLedger)
        repaired += 1
      }
    } catch {
      failed += 1
    }
  }
  return { checked: rows.length, mismatches, repaired, failed, latestLedger }
}

/** Recover a confirmed mint directly from its transaction if the streaming
 * indexer advanced before the RPC event endpoint exposed that ledger. */
export async function indexConfirmedMint(contractId: string, tokenId: number, txHash: string, minter: string) {
  const transaction = await rpc('getTransaction', { hash: txHash })
  if (transaction.status !== 'SUCCESS') return false
  const ledger = Number(transaction.ledger)
  if (!Number.isSafeInteger(ledger) || ledger < 1) return false
  // getEvents can prune older ledgers, while getTransaction retains the
  // successful transaction's contract event XDR. Prefer that durable source
  // and use getEvents only as a fallback for RPCs that omit transaction events.
  const transactionEvents = (transaction.events?.contractEventsXdr ?? []).flatMap((operationEvents: string[]) => operationEvents).flatMap((encoded: string) => {
    try {
      const contractEvent = StellarSdk.xdr.ContractEvent.fromXDR(encoded, 'base64')
      if (contractEvent.type.name !== 'contract' || !contractEvent.contractId) return []
      const eventContractId = StellarSdk.StrKey.encodeContract(contractEvent.contractId.value)
      const body = contractEvent.body.v0
      return [{ txHash, contractId: eventContractId, ledger, topic: body.topics.map((topic: any) => topic.toXDR('base64')), value: body.data.toXDR('base64') }]
    } catch { return [] }
  })
  let events = transactionEvents.filter((event: any) => event.contractId === contractId)
  if (!events.length) {
    const result = await rpc('getEvents', {
      startLedger: ledger,
      endLedger: ledger,
      filters: [{ type: 'contract', contractIds: [contractId] }],
      limit: 100,
    })
    events = (result.events ?? []).filter((event: any) => event.txHash === txHash && event.contractId === contractId)
  }
  const mint = events.find((event: any) => {
    const topics = Array.isArray(event.topic) ? event.topic.map((topic: string) => decode(topic)) : []
    const value = decode(event.value)
    const data = Array.isArray(value) ? value : Array.isArray(value?.values) ? value.values : value
    return topics[0] === 'mint' && topics[1] === minter && Number(Array.isArray(data) ? data[0] : data) === tokenId
  })
  if (!mint) return false

  // The client has already authenticated the minter and this function matches
  // the exact successful on-chain transaction before projecting its events.
  nftContractIds.add(contractId)
  for (const event of events) {
    const applied = await withTransaction(() => applyEvent(event))
    if (applied) lastRun.indexed += 1
  }
  await projectMintMetadata(contractId, tokenId, minter)
  return true
}

export function startIndexer() {
  if (!process.env.DATABASE_URL || !marketplaceId) return
  void runIndexerOnce()
  setInterval(() => void runIndexerOnce(), 15_000)
  setInterval(() => void sendOfferExpiryReminders().catch((error) => {
    lastRun.error = error instanceof Error ? `Expiry reminder: ${error.message}` : 'Expiry reminder failed'
  }), 60_000)
}
