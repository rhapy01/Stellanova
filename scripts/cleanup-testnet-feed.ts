import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import pg from 'pg'
import crypto from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.join(root, '.env') })

if ((process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase() !== 'TESTNET') {
  throw new Error('Refusing to clean sample content: VITE_STELLAR_NETWORK must be TESTNET')
}

const manifestPath = path.join(root, '.testnet-sample-content.json')
if (!fs.existsSync(manifestPath)) throw new Error('No Testnet sample manifest exists')

type SampleState = {
  network: 'TESTNET'
  wallets: string[]
  collections: { slug: string; owner: string }[]
  posts: { id: number; author: string }[]
  assets: { publicId: string; owner: string }[]
}
const state = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SampleState
if (state.network !== 'TESTNET' || state.wallets.length === 0) throw new Error('The sample manifest is invalid or is not for Testnet')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to clean the sample records')

const connection = new URL(process.env.DATABASE_URL)
const database = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 15_000,
  ssl: { rejectUnauthorized: true },
  ...(connection.hostname.endsWith('.neon.tech') ? { sslnegotiation: 'direct' as const } : {}),
})

try {
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    const wallets = state.wallets
    const postIds = state.posts.map((post) => post.id)
    const slugs = state.collections.map((collection) => collection.slug)

    const chainRecords = await client.query(
      'SELECT COUNT(*)::int AS count FROM nft_mints WHERE minter = ANY($1::varchar[]) OR collection_id = ANY($2::varchar[])',
      [wallets, slugs],
    )
    if (Number(chainRecords.rows[0]?.count ?? 0) > 0) throw new Error('Sample wallets have indexed NFTs; refusing cleanup that could hide on-chain assets')

    await client.query('DELETE FROM post_likes WHERE post_id = ANY($1::bigint[]) OR wallet_address = ANY($2::varchar[])', [postIds, wallets])
    await client.query('DELETE FROM post_comments WHERE post_id = ANY($1::bigint[]) OR wallet_address = ANY($2::varchar[])', [postIds, wallets])
    await client.query('DELETE FROM post_reposts WHERE post_id = ANY($1::bigint[]) OR wallet_address = ANY($2::varchar[])', [postIds, wallets])
    await client.query('DELETE FROM creator_follows WHERE wallet_address = ANY($1::varchar[]) OR creator_id = ANY($1::varchar[])', [wallets])
    await client.query('DELETE FROM collection_subscriptions WHERE wallet_address = ANY($1::varchar[]) OR collection_id = ANY($2::varchar[])', [wallets, slugs])
    await client.query('DELETE FROM mint_whitelist WHERE stage_id IN (SELECT id FROM mint_stages WHERE collection_id = ANY($1::varchar[]))', [slugs])
    await client.query('DELETE FROM mint_stages WHERE collection_id = ANY($1::varchar[])', [slugs])
    await client.query('DELETE FROM creator_nft_metadata WHERE creator_wallet = ANY($1::varchar[]) OR collection_id = ANY($2::varchar[])', [wallets, slugs])
    await client.query('DELETE FROM creator_media_uploads WHERE creator_wallet = ANY($1::varchar[])', [wallets])
    await client.query('DELETE FROM posts WHERE author = ANY($1::varchar[])', [wallets])
    await client.query('DELETE FROM collections WHERE owner_wallet = ANY($1::varchar[]) AND slug = ANY($2::varchar[])', [wallets, slugs])
    await client.query('DELETE FROM nft_contract_registry WHERE owner_wallet = ANY($1::varchar[])', [wallets])
    await client.query('DELETE FROM user_profiles WHERE wallet_address = ANY($1::varchar[])', [wallets])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME
  const apiKey = process.env.CLOUDINARY_API_KEY
  const apiSecret = process.env.CLOUDINARY_API_SECRET
  if (state.assets.length && (!cloudName || !apiKey || !apiSecret)) throw new Error('Cloudinary credentials are required to remove uploaded sample media')
  for (const asset of state.assets) {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const params = `public_id=${asset.publicId}&timestamp=${timestamp}`
    const signature = crypto.createHash('sha1').update(`${params}${apiSecret}`).digest('hex')
    const form = new FormData()
    form.append('public_id', asset.publicId)
    form.append('timestamp', timestamp)
    form.append('api_key', apiKey!)
    form.append('signature', signature)
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName!)}/image/destroy`, { method: 'POST', body: form })
    const result = await response.json().catch(() => null) as { result?: string; error?: { message?: string } } | null
    if (!response.ok || (result?.result !== 'ok' && result?.result !== 'not found')) {
      throw new Error(`Could not delete Cloudinary asset ${asset.publicId}: ${result?.error?.message ?? `HTTP ${response.status}`}`)
    }
  }

  fs.unlinkSync(manifestPath)
  console.log(`Removed ${state.posts.length} sample posts, ${state.collections.length} collections, ${state.wallets.length} profiles, and ${state.assets.length} uploaded images.`)
  console.log('The Friendbot-funded Stellar Testnet wallet accounts remain on Testnet; Stellar accounts cannot be deleted.')
} finally {
  await database.end()
}
