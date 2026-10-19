import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import * as StellarSdk from '@stellar/stellar-sdk'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.join(root, '.env') })

if ((process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase() !== 'TESTNET') {
  throw new Error('Refusing to seed: VITE_STELLAR_NETWORK must be TESTNET')
}

const baseUrl = (process.env.STELLANOVA_LOCAL_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const contractId = process.env.STELLAR_NFT_CONTRACT_ID ?? process.env.VITE_STELLAR_NFT_CONTRACT_ID ?? ''
const manifestPath = path.join(root, '.testnet-sample-content.json')
if (!/^C[A-Z2-7]{55}$/.test(contractId)) throw new Error('A deployed Stellar Testnet NFT contract ID is required')
if (fs.existsSync(manifestPath)) throw new Error('A Testnet sample manifest already exists; clean it up before seeding another batch')

type SampleState = {
  version: 1
  network: 'TESTNET'
  status: 'in-progress' | 'complete'
  createdAt: string
  wallets: string[]
  collections: { slug: string; owner: string }[]
  posts: { id: number; author: string }[]
  assets: { publicId: string; owner: string }[]
}

const state: SampleState = {
  version: 1,
  network: 'TESTNET',
  status: 'in-progress',
  createdAt: new Date().toISOString(),
  wallets: [],
  collections: [],
  posts: [],
  assets: [],
}

function saveState() {
  fs.writeFileSync(manifestPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

type Session = { address: string; token: string }

async function api<T>(endpoint: string, init: RequestInit = {}, session?: Session): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (session) {
    headers.set('x-stellar-address', session.address)
    headers.set('authorization', `Bearer ${session.token}`)
  }
  const response = await fetch(`${baseUrl}${endpoint}`, { ...init, headers })
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null
  if (!response.ok || !payload) throw new Error(`${endpoint}: ${payload?.error ?? `HTTP ${response.status}`}`)
  return payload
}

async function authenticate(keypair: StellarSdk.Keypair): Promise<Session> {
  const address = keypair.publicKey()
  const challenge = await api<{ challengeId: string; message: string }>('/api/auth/challenge', {
    method: 'POST', body: JSON.stringify({ wallet: address }),
  })
  const signature = Buffer.from(keypair.signMessage(challenge.message)).toString('base64')
  const result = await api<{ token: string; wallet: string }>('/api/auth/verify', {
    method: 'POST', body: JSON.stringify({ wallet: address, challengeId: challenge.challengeId, signature }),
  })
  if (result.wallet !== address) throw new Error('The server authenticated a different wallet')
  return { address, token: result.token }
}

async function fundTestnetWallet(address: string) {
  const horizon = `https://horizon-testnet.stellar.org/accounts/${encodeURIComponent(address)}`
  const check = await fetch(horizon, { signal: AbortSignal.timeout(12_000) })
  if (check.ok) return
  if (check.status !== 404) throw new Error(`Horizon could not verify Testnet wallet ${address}`)
  const funded = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(30_000) })
  if (!funded.ok) throw new Error(`Friendbot could not fund Testnet wallet ${address} (HTTP ${funded.status})`)
  const confirmation = await fetch(horizon, { signal: AbortSignal.timeout(12_000) })
  if (!confirmation.ok) throw new Error(`Friendbot funding was not visible on Horizon for ${address}`)
}

async function uploadPhoto(session: Session, fileName: string, url: string, collection: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Could not fetch artwork source ${url} (HTTP ${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg'
  if (contentType !== 'image/jpeg') throw new Error(`Artwork source returned unsupported type ${contentType}`)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const signature = await api<{
    cloudName: string; apiKey: string; timestamp: string; folder: string; publicId: string; signature: string; collectionId: string
  }>('/api/media/upload-signature', {
    method: 'POST',
    body: JSON.stringify({ fileName, contentType, bytes: bytes.length, sha256, collection }),
  }, session)

  const form = new FormData()
  form.append('file', new Blob([bytes], { type: contentType }), fileName)
  form.append('api_key', signature.apiKey)
  form.append('timestamp', signature.timestamp)
  form.append('folder', signature.folder)
  form.append('public_id', signature.publicId)
  form.append('signature', signature.signature)
  const cloudinaryResponse = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(signature.cloudName)}/auto/upload`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(60_000),
  })
  const cloudinaryAsset = await cloudinaryResponse.json().catch(() => null) as { secure_url?: string; public_id?: string; error?: { message?: string } } | null
  if (!cloudinaryResponse.ok || !cloudinaryAsset?.secure_url || !cloudinaryAsset.public_id) {
    throw new Error(cloudinaryAsset?.error?.message ?? `Cloudinary upload failed (HTTP ${cloudinaryResponse.status})`)
  }
  state.assets.push({ publicId: cloudinaryAsset.public_id, owner: session.address })
  saveState()
  await api('/api/media/upload-complete', {
    method: 'POST',
    body: JSON.stringify({ collection: signature.collectionId, fileName, contentType, bytes: bytes.length, sha256, cloudinaryUrl: cloudinaryAsset.secure_url }),
  }, session)
  return cloudinaryAsset.secure_url
}

const creators = [
  { name: 'Ari Bloom', symbol: 'BLOOM', bio: 'Testnet sample creator exploring color, light and quiet landscapes.', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=240&h=240&fit=crop&crop=faces&q=82', collection: 'Light Studies', description: 'A visual journal of landscape, color and changing light.', photos: [
    ['1470770841072-f978cf4d019e', 'First light over still water', 'Some mornings feel like the world has not quite woken up yet. A study in soft reflections and open space.'],
    ['1506744038136-46273834b3fb', 'Where the valley opens', 'Collecting small moments of scale, distance and the feeling of finding a new path.'],
    ['1470252649378-9c29740c9fa8', 'The last warm minute', 'A little color before the day closes. Shared as a visual reference for the next piece.'],
  ] as [string, string, string][] },
  { name: 'Noah Reed', symbol: 'NORTH', bio: 'Testnet sample creator collecting textures from woods and open trails.', avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=240&h=240&fit=crop&crop=faces&q=82', collection: 'Northline Fieldnotes', description: 'Field notes on forests, trails and the details worth stopping for.', photos: [
    ['1441974231531-c6227db76b6e', 'A green room after rain', 'The forest changes its whole palette after the rain passes. Keeping this frame for a future series.'],
    ['1511497584788-876760111969', 'Between the tall trees', 'A quiet walk and a reminder that the best composition is sometimes already there.'],
    ['1472214103451-9374bd1c798e', 'A path through green', 'Testing a more patient, natural palette for upcoming work. What would you collect from this scene?'],
  ] as [string, string, string][] },
  { name: 'Mina Sol', symbol: 'SOLAR', bio: 'Testnet sample creator drawn to skies, coastlines and shifting horizons.', avatar: 'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?w=240&h=240&fit=crop&crop=faces&q=82', collection: 'Horizon Notes', description: 'A growing collection of horizons, water and in-between moments.', photos: [
    ['1518837695005-2083093ee35b', 'Blue hour at the edge', 'The horizon keeps moving while you look at it. Saving this palette for an edition idea.'],
    ['1501785888041-af3ef285b470', 'A wider view', 'I keep coming back to scenes that make a little room to breathe.'],
    ['1500530855697-b586d89ba3ee', 'Light across the distance', 'One frame, a long walk, and a color story that might become something more.'],
  ] as [string, string, string][] },
  { name: 'Theo Park', symbol: 'FRAME', bio: 'Testnet sample creator studying atmosphere, shape and everyday scenes.', avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=240&h=240&fit=crop&crop=faces&q=82', collection: 'Open Frame', description: 'A work-in-progress archive of scenes, shapes and visual experiments.', photos: [
    ['1470071459604-3b5ec3a7fe05', 'Clouds settling in', 'A slow frame from a day when the weather kept rewriting the scene.'],
    ['1500534623283-312aade485b7', 'A study in distance', 'Exploring how much of a story can sit in the space between foreground and sky.'],
    ['1439853949127-fa647821eba0', 'The shape of a quiet day', 'A small visual note for the collection. More work is taking shape on Testnet.'],
  ] as [string, string, string][] },
]

const samplePhoto = (id: string, width = 1400, height?: number) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${width}${height ? `&h=${height}` : ''}&q=84`

const posts: { id: number; author: string }[] = []
const sessions: Session[] = []

try {
  const health = await api<{ configured: boolean }>('/api/media/health')
  const providers = await api<{ cloudinary: { enabled: boolean } }>('/api/media/providers')
  if (!health.configured || !providers.cloudinary.enabled) throw new Error('Cloudinary upload flow is not ready')
  if ((await api<{ collections: unknown[] }>('/api/collections')).collections.length) {
    console.log('Existing collections were found. This batch will create additional, clearly identified Testnet sample collections.')
  }
  saveState()

  for (let creatorIndex = 0; creatorIndex < creators.length; creatorIndex += 1) {
    const creator = creators[creatorIndex]
    const keypair = StellarSdk.Keypair.random()
    const address = keypair.publicKey()
    await fundTestnetWallet(address)
    state.wallets.push(address)
    saveState()
    const session = await authenticate(keypair)
    sessions.push(session)

    const avatarUrl = await uploadPhoto(session, `creator-${creatorIndex + 1}-avatar.jpg`, creator.avatar, 'sample-feed')
    await api('/api/account/profile', {
      method: 'POST', body: JSON.stringify({ displayName: creator.name, avatar: avatarUrl, bio: creator.bio }),
    }, session)

    await api('/api/nft/contracts/register', {
      method: 'POST', body: JSON.stringify({ contractId }),
    }, session)
    const coverUrl = await uploadPhoto(session, `collection-${creatorIndex + 1}-cover.jpg`, samplePhoto(creator.photos[0][0]), 'sample-feed')
    const collection = await api<{ slug: string }>('/api/account/collections', {
      method: 'POST', body: JSON.stringify({ name: creator.collection, symbol: creator.symbol, description: creator.description, cover: coverUrl, contractId }),
    }, session)
    state.collections.push({ slug: collection.slug, owner: address })
    saveState()

    for (let photoIndex = 0; photoIndex < creator.photos.length; photoIndex += 1) {
      const [photoId, title, caption] = creator.photos[photoIndex]
      const mediaUrl = photoIndex === 0 ? coverUrl : await uploadPhoto(session, `creator-${creatorIndex + 1}-post-${photoIndex + 1}.jpg`, samplePhoto(photoId), 'sample-feed')
      const result = await api<{ id: number }>('/api/posts', {
        method: 'POST', body: JSON.stringify({ caption: `${title}. ${caption} Photo: Unsplash.`, mediaUrl, mediaType: 'image', kind: 'post' }),
      }, session)
      posts.push({ id: result.id, author: address })
      state.posts.push({ id: result.id, author: address })
      saveState()
    }
    console.log(`Created Testnet creator ${creator.name} with ${creator.photos.length} posts.`)
  }

  // Add actual cross-account activity through the same endpoints used by users.
  for (let index = 0; index < posts.length; index += 1) {
    const post = posts[index]
    for (const offset of [1, 2]) {
      const liker = sessions[(index + offset) % sessions.length]
      if (liker.address !== post.author) await api(`/api/posts/${post.id}/like`, { method: 'POST' }, liker)
    }
    if (index % 2 === 0) {
      const commenter = sessions[(index + 3) % sessions.length]
      if (commenter.address !== post.author) {
        await api(`/api/posts/${post.id}/comment`, {
          method: 'POST', body: JSON.stringify({ body: 'This palette and framing are lovely. Looking forward to seeing where the collection goes.' }),
        }, commenter)
      }
    }
  }

  state.status = 'complete'
  saveState()
  console.log(`Seed complete: ${state.wallets.length} funded Testnet creator wallets, ${state.collections.length} collections, ${state.posts.length} posts.`)
  console.log(`Public cleanup manifest: ${manifestPath}`)
} catch (error) {
  saveState()
  console.error(`Seed stopped with a cleanup manifest at ${manifestPath}. ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
