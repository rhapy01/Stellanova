import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { config as loadEnv } from 'dotenv'
import { createServer as createHttpServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
loadEnv()
import express from 'express'
import multer from 'multer'
import * as StellarSdk from '@stellar/stellar-sdk'
import { PrivyClient } from '@privy-io/node'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { checkDatabaseConnection, databaseAvailable, ensureSchema, query, readIndexerCheckpoint, withTransaction } from './db.js'
import { indexConfirmedMint, indexerStatus, reconcileMarketplaceStateForWallet, reconcileOwnershipAgainstSoroban, runIndexerOnce, runMarketplaceKeeper, sendOfferExpiryReminders, startIndexer } from './indexer.js'
import { mailConfigured, marketplaceEmail, sendMail, welcomeEmail } from './mail.js'
import { browserPushConfig, notifyUser, sendBrowserPush } from './push.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const port = Number(process.env.PORT ?? 3000)
const isProduction = process.env.NODE_ENV === 'production'
const isVercel = Boolean(process.env.VERCEL)

const r2Enabled = Boolean(process.env.CLOUDFLARE_R2_ENDPOINT && process.env.CLOUDFLARE_R2_ACCESS_KEY_ID && process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY && process.env.CLOUDFLARE_R2_BUCKET && process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL)
const cloudinaryEnabled = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
const uploadToken = process.env.NFTGRAM_MEDIA_UPLOAD_TOKEN
const nftId = process.env.STELLAR_NFT_CONTRACT_ID ?? process.env.VITE_STELLAR_NFT_CONTRACT_ID ?? null

// Cloudflare documents the *.r2.dev URL as a non-production development URL.
// A production custom media domain must be attached in the Cloudflare dashboard.
// This flag lets the operator verify they are no longer serving from r2.dev.
function r2PublicBaseUrl(): string | null {
  return process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL?.replace(/\/$/, '') || null
}
function r2UsingProductionDomain(): boolean {
  const base = r2PublicBaseUrl()
  if (!base) return false
  try {
    return !new URL(base).hostname.endsWith('.r2.dev')
  } catch {
    return false
  }
}
function r2ProductionReadiness(): { baseUrl: string | null; productionDomain: boolean; describesOnR2Dev: boolean } {
  const baseUrl = r2PublicBaseUrl()
  return {
    baseUrl,
    productionDomain: r2UsingProductionDomain(),
    describesOnR2Dev: Boolean(baseUrl) && !r2UsingProductionDomain(),
  }
}

const r2 = r2Enabled ? new S3Client({
  endpoint: process.env.CLOUDFLARE_R2_ENDPOINT,
  region: 'auto',
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
  },
}) : null

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 12, fieldSize: 16 * 1024, parts: 13, headerPairs: 100 },
})
const visionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, fieldSize: 8 * 1024, parts: 5, headerPairs: 100 },
})

const app = express()
app.disable('x-powered-by')
// Vercel overwrites X-Forwarded-For at its edge. Do not trust arbitrary
// forwarded headers when this Express app is run directly elsewhere.
app.set('trust proxy', isVercel)
const requestRateBuckets = new Map<string, { count: number; resetsAt: number }>()
function processRateLimit(scope: string, maxRequests: number, windowMs: number): express.RequestHandler {
  return (req, res, next) => {
    const now = Date.now()
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown'
    const key = `${scope}:${clientIp}`
    let bucket = requestRateBuckets.get(key)
    if (!bucket || bucket.resetsAt <= now) {
      bucket = { count: 0, resetsAt: now + windowMs }
      requestRateBuckets.set(key, bucket)
    }
    bucket.count += 1
    if (bucket.count > maxRequests) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetsAt - now) / 1000))))
      return res.status(429).json({ error: 'Too many requests. Please wait and try again.' })
    }
    if (requestRateBuckets.size > 10_000) {
      for (const [entryKey, entry] of requestRateBuckets) {
        if (entry.resetsAt <= now) requestRateBuckets.delete(entryKey)
      }
      while (requestRateBuckets.size > 10_000) requestRateBuckets.delete(requestRateBuckets.keys().next().value!)
    }
    next()
  }
}
app.use((req, res, next) => {
  const suppliedId = req.header('x-request-id') ?? ''
  const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedId)
    ? suppliedId
    : crypto.randomUUID()
  const startedAt = Date.now()
  res.setHeader('X-Request-Id', requestId)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  res.on('finish', () => {
    if (!req.path.startsWith('/api/')) return
    const statusCode = res.statusCode
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : '/api/unmatched'
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
      event: 'http_request',
      requestId,
      method: req.method,
      route,
      statusCode,
      durationMs: Date.now() - startedAt,
    })
    if (statusCode >= 500) console.error(record)
    else if (statusCode >= 400) console.warn(record)
    else console.log(record)
    if (statusCode >= 500 && route !== '/api/admin/ops/health' && route !== '/api/cron/ops-monitor') {
      const alertKey = `api:${route}:${statusCode}`.slice(0, 96)
      void deliverOpsAlert('degraded', `API returned HTTP ${statusCode} on ${route}. Request ID: ${requestId}.`, alertKey)
    }
  })
  next()
})
// A bounded per-process backstop for accidental loops and burst abuse. Vercel
// WAF remains the distributed edge control; this map is intentionally not
// treated as a substitute for it across serverless instances.
app.use('/api', processRateLimit('api', 300, 60_000))
app.use(express.json({ limit: '256kb' }))

app.get('/api/feedback', async (_req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Feedback is temporarily unavailable' })
  try {
    await ensureSchema()
    const entries = await query<{ id: number; category: 'idea' | 'problem' | 'praise'; title: string; body: string; status: 'new' | 'planned' | 'in_progress' | 'done'; created_at: string }[]>(
      `SELECT id, category, title, body, status, created_at FROM public_feedback ORDER BY created_at DESC LIMIT 100`,
    )
    res.setHeader('Cache-Control', 'no-store')
    res.json({ entries })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Feedback is temporarily unavailable' })
  }
})

app.post('/api/feedback', processRateLimit('public-feedback', 5, 60 * 60_000), async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Feedback is temporarily unavailable' })
  const category = String(req.body?.category ?? '').trim()
  const title = String(req.body?.title ?? '').trim()
  const body = String(req.body?.body ?? '').trim()
  if (!['idea', 'problem', 'praise'].includes(category)) return res.status(400).json({ error: 'Choose an idea, problem, or praise category.' })
  if (title.length < 4 || title.length > 120) return res.status(400).json({ error: 'Title must be 4–120 characters.' })
  if (body.length < 10 || body.length > 2000) return res.status(400).json({ error: 'Details must be 10–2,000 characters.' })
  try {
    await ensureSchema()
    const rows = await query<{ id: number; category: 'idea' | 'problem' | 'praise'; title: string; body: string; status: 'new' | 'planned' | 'in_progress' | 'done'; created_at: string }[]>(
      `INSERT INTO public_feedback (category, title, body) VALUES (?, ?, ?) RETURNING id, category, title, body, status, created_at`,
      [category, title, body],
    )
    res.status(201).json({ entry: rows[0] })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Feedback could not be saved' })
  }
})

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>\"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[character]!)
}

function stripAiMarkdown(value: string): string {
  return value
    .replace(/```(?:json|markdown|text)?\s*([\s\S]*?)```/gi, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .trim()
}

function extractAiJsonObject<T>(value: string): T | null {
  const text = stripAiMarkdown(value)
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (start < 0) {
      if (character === '{') { start = index; depth = 1 }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, index + 1)) as T } catch { return null }
    }
  }
  return null
}

const publicSiteOrigin = (process.env.PUBLIC_SITE_URL || 'https://stelanova.vercel.app').replace(/\/$/, '')

app.get(['/api/robots.txt', '/robots.txt'], (_req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /account',
    'Disallow: /saved',
    'Disallow: /settings',
    'Disallow: /analytics',
    'Disallow: /create/',
    'Disallow: /admin/',
    `Sitemap: ${publicSiteOrigin}/sitemap.xml`,
    '',
  ].join('\n'))
})

app.get(['/api/sitemap.xml', '/sitemap.xml'], async (_req, res) => {
  const publicUrls = new Set([`${publicSiteOrigin}/`, `${publicSiteOrigin}/explore`, `${publicSiteOrigin}/collections`])
  if (databaseAvailable()) {
    try {
      await ensureSchema()
      const [collectionRows, nftRows, postRows, creatorRows] = await Promise.all([
        query<{ slug: string }[]>('SELECT slug FROM collections WHERE contract_id IS NOT NULL ORDER BY created_at DESC LIMIT 5000'),
        query<{ contract_id: string; token_id: number }[]>('SELECT contract_id, token_id FROM nft_mints WHERE contract_id IS NOT NULL ORDER BY created_at DESC LIMIT 5000'),
        query<{ id: number }[]>('SELECT id FROM posts WHERE COALESCE((to_jsonb(posts)->>\'is_demo\')::boolean, FALSE) = FALSE ORDER BY created_at DESC LIMIT 5000'),
        query<{ wallet_address: string; creator_username: string | null }[]>('SELECT wallet_address, creator_username FROM user_profiles ORDER BY updated_at DESC LIMIT 5000'),
      ])
      for (const row of collectionRows) publicUrls.add(`${publicSiteOrigin}/collection/${encodeURIComponent(row.slug)}`)
      for (const row of nftRows) publicUrls.add(`${publicSiteOrigin}/nft/minted-${encodeURIComponent(row.contract_id.toLowerCase())}-${row.token_id}`)
      for (const row of postRows) publicUrls.add(`${publicSiteOrigin}/post/${row.id}`)
      for (const row of creatorRows) publicUrls.add(`${publicSiteOrigin}/creator/${encodeURIComponent(row.creator_username || row.wallet_address)}`)
    } catch (error) {
      console.error('Public sitemap could not load dynamic routes', error)
      return res.status(503).type('text/plain').send('Sitemap is temporarily unavailable')
    }
  }
  const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&apos;')
  const body = [...publicUrls].map((url) => `  <url><loc>${xmlEscape(url)}</loc></url>`).join('\n')
  res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=3600')
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`)
})

app.get(['/api/share/page/:page', '/explore', '/collections'], async (req, res) => {
  const page = String(req.params.page ?? req.path.slice(1))
  const pages: Record<string, { title: string; description: string; url: string }> = {
    explore: { title: 'Explore digital art · StellaNova', description: 'Browse digital artwork and NFTs shared by creators on StellaNova.', url: `${publicSiteOrigin}/explore` },
    collections: { title: 'NFT collections · StellaNova', description: 'Discover creator collections and live drops on StellaNova.', url: `${publicSiteOrigin}/collections` },
  }
  const metadata = pages[page]
  if (!metadata) return res.status(404).type('text/plain').send('Page not found')
  try { return await sendSocialPage(res, metadata) }
  catch (error) {
    console.error('Public page render failed', error)
    return res.status(503).type('text/plain').send('Page is temporarily unavailable')
  }
})

app.get(['/api/share/creator/:id', '/creator/:id'], async (req, res) => {
  const id = String(req.params.id ?? '').trim().replace(/^@/, '')
  const isWallet = stellarAddress.test(id)
  if (!isWallet && !/^[a-z][a-z0-9_]{2,23}$/i.test(id)) return res.status(404).type('text/plain').send('Creator not found')
  if (!databaseAvailable()) return res.status(503).type('text/plain').send('Creator information is temporarily unavailable')
  try {
    await ensureSchema()
    const profiles = await query<{ wallet_address: string; display_name: string; creator_username: string | null; bio: string }[]>(
      'SELECT wallet_address, display_name, creator_username, bio FROM user_profiles WHERE (? = TRUE AND lower(wallet_address) = lower(?)) OR lower(creator_username) = lower(?) LIMIT 1', [isWallet, id, id],
    )
    const profile = profiles[0]
    if (!profile) return res.status(404).type('text/plain').send('Creator not found')
    const name = profile.creator_username ? `@${profile.creator_username}` : profile.display_name.trim() || 'Stellar creator'
    const description = profile.bio.trim() || `Explore artwork and collections from ${name} on StellaNova.`
    const publicId = profile.creator_username || profile.wallet_address
    return await sendSocialPage(res, { title: `${name} · StellaNova`, description, url: `${publicSiteOrigin}/creator/${encodeURIComponent(publicId)}` })
  } catch (error) {
    console.error('Creator page render failed', error)
    return res.status(503).type('text/plain').send('Creator information is temporarily unavailable')
  }
})

async function sendSocialPage(res: express.Response, metadata: { title: string; description: string; image?: string | null; url: string; type?: 'website' | 'article' }) {
  const file = await readFile(path.join(root, 'dist', 'index.html'), 'utf8')
  const title = escapeHtml(metadata.title)
  const description = escapeHtml(metadata.description)
  let imageUrl = '/icon-512.png'
  try { imageUrl = new URL(metadata.image || '/icon-512.png', metadata.url).toString() } catch { /* use the relative fallback */ }
  const meta = [
    ['name', 'description', metadata.description],
    ['property', 'og:site_name', 'StellaNova'],
    ['property', 'og:type', metadata.type ?? 'website'],
    ['property', 'og:title', metadata.title],
    ['property', 'og:description', metadata.description],
    ['property', 'og:image', imageUrl],
    ['property', 'og:url', metadata.url],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', metadata.title],
    ['name', 'twitter:description', metadata.description],
    ['name', 'twitter:image', imageUrl],
  ] as const
  let html = file.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
  const missing: string[] = []
  for (const [attribute, key, value] of meta) {
    const expression = new RegExp(`<meta\\s+${attribute}=\"${key}\"[^>]*>`, 'i')
    const tag = `<meta ${attribute}=\"${key}\" content=\"${escapeHtml(value)}\" />`
    if (expression.test(html)) html = html.replace(expression, tag)
    else missing.push(tag)
  }
  if (missing.length) html = html.replace('</head>', `    ${missing.join('\n    ')}\n  </head>`)
  const canonical = `<link rel="canonical" href="${escapeHtml(metadata.url)}" />`
  html = /<link\s+rel="canonical"[^>]*>/i.test(html)
    ? html.replace(/<link\s+rel="canonical"[^>]*>/i, canonical)
    : html.replace('</head>', `    ${canonical}\n  </head>`)
  const pageSummary = `<main class="crawler-page-summary"><h1>${title}</h1><p>${description}</p><a href="${escapeHtml(metadata.url)}">Open this page in StellaNova</a></main>`
  const noScriptSummary = `<noscript>${pageSummary}</noscript>`
  html = html.replace(/<noscript>[\s\S]*?<\/noscript>/i, noScriptSummary)
  html = html.replace(/<div id="root">[\s\S]*?<\/div>/i, `<div id="root"></div>`)
  res.type('html').send(html)
}

app.get(['/api/share/collection/:slug', '/collection/:slug'], async (req, res) => {
  const slugValue = slug(String(req.params.slug))
  try {
    if (!databaseAvailable()) return res.status(503).type('text/plain').send('Collection information is temporarily unavailable')
    await ensureSchema()
    const rows = await query<{ name: string; description: string; cover: string | null }[]>(
      'SELECT name, description, cover FROM collections WHERE slug = ? LIMIT 1', [slugValue],
    )
    const collection = rows[0]
    if (!collection) return res.status(404).type('text/plain').send('Collection not found')
    const baseUrl = publicSiteOrigin
    return await sendSocialPage(res, {
      title: `${collection.name} · StellaNova`,
      description: collection.description || `Explore ${collection.name} on StellaNova.`,
      image: collection.cover,
      url: `${baseUrl}/collection/${encodeURIComponent(slugValue)}`,
    })
  } catch (error) {
    console.error('Collection social preview failed', error)
    return res.status(503).send('Collection preview is temporarily unavailable')
  }
})

app.get(['/api/share/nft/:id', '/nft/:id'], async (req, res) => {
  const id = String(req.params.id)
  const match = /^minted-([A-Z0-9]{56})-(\d+)$/i.exec(id)
  if (!match) return res.status(404).type('text/plain').send('NFT not found')
  if (!databaseAvailable()) return res.status(503).type('text/plain').send('NFT information is temporarily unavailable')
  const baseUrl = publicSiteOrigin
  const url = `${baseUrl}/nft/${encodeURIComponent(id)}`
  try {
    await ensureSchema()
    const rows = await query<{ title: string; description: string | null; image: string | null; collection_name: string | null; collection_revealed: boolean | null }[]>(
        `SELECT COALESCE(NULLIF(m.title, ''), NULLIF(meta.name, ''), 'NFT') AS title,
                meta.description, COALESCE(NULLIF(meta.image, ''), NULLIF(m.image, '')) AS image,
                c.name AS collection_name, c.revealed AS collection_revealed
         FROM nft_mints m
         LEFT JOIN creator_nft_metadata meta ON meta.metadata_uri = m.metadata_uri
         LEFT JOIN collections c ON c.slug = m.collection_id
         WHERE LOWER(m.contract_id) = LOWER(?) AND m.token_id = ?
         LIMIT 1`,
        [match[1], Number(match[2])],
      )
    const nft = rows[0]
    if (!nft) return res.status(404).type('text/plain').send('NFT not found')
    const unrevealed = nft.collection_revealed === false
    const title = unrevealed ? `${nft.collection_name || 'Collection'} · StellaNova` : `${nft.title} · StellaNova`
    const description = unrevealed
      ? `${nft.collection_name || 'This collection'} has not revealed its artwork yet.`
      : nft.description?.trim() || `View ${nft.title} on StellaNova.`
    return await sendSocialPage(res, { title, description, image: unrevealed ? null : nft.image, url, type: 'article' })
  } catch (error) {
    console.error('NFT social preview failed', error)
    return res.status(503).send('NFT preview is temporarily unavailable')
  }
})

app.get(['/api/share/post/:id', '/post/:id'], async (req, res) => {
  const postId = Number(req.params.id)
  if (!Number.isSafeInteger(postId) || postId <= 0) return res.status(404).type('text/plain').send('Post not found')
  if (!databaseAvailable()) return res.status(503).type('text/plain').send('Post information is temporarily unavailable')
  const baseUrl = publicSiteOrigin
  const url = `${baseUrl}/post/${postId}`
  try {
    await ensureSchema()
    const rows = await query<{ caption: string; media_url: string; avatar: string; author_name: string; author_type: 'user' | 'collection'; collection_name: string | null; linked_nft_id: string | null }[]>(
        `SELECT p.caption, p.media_url, p.avatar, p.author_name, p.author_type, c.name AS collection_name, p.linked_nft_id
         FROM posts p LEFT JOIN collections c ON c.slug = p.collection_id
         WHERE p.id = ? AND COALESCE((to_jsonb(p)->>'is_demo')::boolean, FALSE) = FALSE LIMIT 1`,
        [postId],
      )
    const post = rows[0]
    if (!post) return res.status(404).type('text/plain').send('Post not found')
    const author = post.author_type === 'collection' ? post.collection_name || post.author_name : post.author_name || 'Creator'
    let linkedNftImage: string | null = null
    const linkedNftMatch = /^minted-([A-Z0-9]{56})-(\d+)$/i.exec(post.linked_nft_id ?? '')
    if (!post.media_url && linkedNftMatch) {
      const linkedNfts = await query<{ image: string | null; collection_cover: string | null; collection_revealed: boolean | null }[]>(
        `SELECT CASE WHEN c.revealed = FALSE THEN NULLIF(c.cover, '')
                     ELSE COALESCE(NULLIF(meta.image, ''), NULLIF(m.image, ''))
                END AS image,
                c.cover AS collection_cover, c.revealed AS collection_revealed
         FROM nft_mints m
         INNER JOIN verified_nft_mints v ON v.contract_id = m.contract_id AND v.token_id = m.token_id
         LEFT JOIN creator_nft_metadata meta ON meta.metadata_uri = m.metadata_uri
         LEFT JOIN collections c ON c.slug = m.collection_id
         WHERE LOWER(m.contract_id) = LOWER(?) AND m.token_id = ? LIMIT 1`,
        [linkedNftMatch[1], Number(linkedNftMatch[2])],
      )
      const linkedNft = linkedNfts[0]
      linkedNftImage = linkedNft?.image || (linkedNft?.collection_revealed === false ? linkedNft.collection_cover : null) || null
    }
    return await sendSocialPage(res, {
      title: `${author} shared a post · StellaNova`,
      description: post.caption?.trim() || `View ${author}'s post on StellaNova.`,
      image: post.media_url || linkedNftImage || post.avatar,
      url,
      type: 'article',
    })
  } catch (error) {
    console.error('Post social preview failed', error)
    return res.status(503).send('Post preview is temporarily unavailable')
  }
})

const stellarAddress = /^G[A-Z2-7]{55}$/i
const pendingTestnetFunding = new Map<string, Promise<void>>()
const privyClient = process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET
  ? new PrivyClient({ appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET })
  : null

async function ensureTestnetAccountFunded(wallet: string): Promise<void> {
  const horizonUrl = `https://horizon-testnet.stellar.org/accounts/${encodeURIComponent(wallet)}`
  const existing = await fetch(horizonUrl, { signal: AbortSignal.timeout(8_000) })
  if (existing.ok) return
  if (existing.status !== 404) throw new Error('Unable to check Testnet account activation')

  const pending = pendingTestnetFunding.get(wallet)
  if (pending) return pending
  const funding = (async () => {
    const friendbot = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(wallet)}`, { signal: AbortSignal.timeout(20_000) })
    // Another login may fund the same account between the Horizon check and Friendbot request.
    if (!friendbot.ok) {
      const raced = await fetch(horizonUrl, { signal: AbortSignal.timeout(8_000) })
      if (!raced.ok) throw new Error('Testnet faucet is temporarily unavailable')
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const confirmed = await fetch(horizonUrl, { signal: AbortSignal.timeout(8_000) })
      if (confirmed.ok) return
      if (confirmed.status !== 404) throw new Error('Unable to verify Testnet account activation')
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error('Testnet account activation is still pending')
  })()
  pendingTestnetFunding.set(wallet, funding)
  try {
    await funding
  } finally {
    pendingTestnetFunding.delete(wallet)
  }
}

async function hasWalletHistory(wallet: string): Promise<boolean> {
  const rows = await query<{ found: boolean }[]>(
    `SELECT (
      EXISTS (SELECT 1 FROM collections WHERE LOWER(owner_wallet) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM user_profiles WHERE LOWER(wallet_address) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM posts WHERE LOWER(author) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM verified_nft_mints WHERE LOWER(minter) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM notifications WHERE LOWER(wallet_address) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM creator_media_uploads WHERE LOWER(creator_wallet) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM nft_likes WHERE LOWER(wallet_address) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM nft_comments WHERE LOWER(wallet_address) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM nft_bookmarks WHERE LOWER(wallet_address) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM post_likes WHERE LOWER(wallet_address) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM post_comments WHERE LOWER(wallet_address) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM creator_follows WHERE LOWER(wallet_address) = LOWER(?)) OR
      EXISTS (SELECT 1 FROM collection_subscriptions WHERE LOWER(wallet_address) = LOWER(?))
    ) AS found`,
    Array.from({ length: 13 }, () => wallet),
  )
  return Boolean(rows[0]?.found)
}

async function attributeNewWalletReferral(wallet: string, rawCode: unknown): Promise<boolean> {
  const code = String(rawCode ?? '').trim().toUpperCase()
  if (!/^[A-F0-9]{16}$/.test(code)) return false
  const referrer = await query<{ wallet_address: string }[]>('SELECT wallet_address FROM referral_codes WHERE code = ? LIMIT 1', [code])
  const referrerWallet = referrer[0]?.wallet_address
  if (!referrerWallet || referrerWallet.toLowerCase() === wallet.toLowerCase()) return false
  const result = await query<{ referred_wallet: string }[]>(
    'INSERT INTO referrals (referred_wallet, referrer_wallet, referral_code) VALUES (?, ?, ?) ON CONFLICT (referred_wallet) DO NOTHING RETURNING referred_wallet',
    [wallet, referrerWallet, code],
  )
  return result.length > 0
}

app.post('/api/auth/privy/session', processRateLimit('privy-session', 20, 10 * 60_000), async (req, res) => {
  if (!privyClient) return res.status(503).json({ error: 'Email wallet sign-in is not configured yet' })
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  const authorization = req.header('authorization') ?? ''
  const accessToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!accessToken) return res.status(401).json({ error: 'Sign in with your email first' })
  try {
    const claims = await privyClient.utils().auth().verifyAccessToken(accessToken)
    const user = await privyClient.users()._get(claims.user_id)
    const account = user.linked_accounts.find((linked) => linked.type === 'wallet' && linked.chain_type === 'stellar' && linked.wallet_client_type === 'privy')
    if (!account || account.type !== 'wallet' || !stellarAddress.test(account.address)) {
      return res.status(403).json({ error: 'This email account does not have an StellaNova Stellar wallet' })
    }
    const emailAccount = user.linked_accounts.find((linked) => linked.type === 'email')
    const accountEmail = emailAccount && 'address' in emailAccount && typeof emailAccount.address === 'string' ? emailAccount.address.trim().toLowerCase() : ''
    await ensureSchema()
    const freshAccount = await query<{ wallet_address: string }[]>('INSERT INTO wallet_accounts (wallet_address) VALUES (?) ON CONFLICT (wallet_address) DO NOTHING RETURNING wallet_address', [account.address])
    const firstAccountUse = freshAccount.length > 0 && !(await hasWalletHistory(account.address))
    await query('INSERT INTO user_profiles (wallet_address, email) VALUES (?, ?) ON CONFLICT (wallet_address) DO UPDATE SET email = COALESCE(EXCLUDED.email, user_profiles.email), updated_at = now()', [account.address, accountEmail || null])
    const referralApplied = firstAccountUse ? await attributeNewWalletReferral(account.address, req.body?.referralCode) : false
    if (String(process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase() === 'TESTNET') {
      try {
        await ensureTestnetAccountFunded(account.address)
      } catch (error) {
        return res.status(503).json({ error: error instanceof Error ? error.message : 'Testnet wallet activation is temporarily unavailable' })
      }
    }
    await ensureSchema()
    await query('DELETE FROM wallet_sessions WHERE expires_at <= now()')
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 12 * 60 * 60_000)
    await query('INSERT INTO wallet_sessions (token_hash, wallet_address, expires_at) VALUES (?, ?, ?)', [sha256(Buffer.from(token)), account.address, expiresAt])
    if (accountEmail && mailConfigured()) {
      try {
        const welcomeState = await query<{ welcome_email_sent_at: string | null }[]>(
          'SELECT welcome_email_sent_at FROM user_profiles WHERE LOWER(wallet_address) = LOWER(?) LIMIT 1',
          [account.address],
        )
        if (welcomeState[0]?.welcome_email_sent_at == null) {
          const welcome = welcomeEmail(accountEmail, account.address)
          const delivery = await sendMail({ to: accountEmail, ...welcome })
          if (delivery.sent) {
            await query('UPDATE user_profiles SET welcome_email_sent_at = now(), updated_at = now() WHERE LOWER(wallet_address) = LOWER(?) AND welcome_email_sent_at IS NULL', [account.address])
          } else {
            console.warn('Welcome email delivery failed:', delivery.error ?? 'unknown SMTP error')
          }
        }
      } catch (error) {
        // Mail is a best-effort part of onboarding; it must not block sign-in.
        console.warn('Welcome email could not be sent:', error instanceof Error ? error.message : 'unknown error')
      }
    }
    res.json({ token, wallet: account.address, newAccount: firstAccountUse, referralApplied, expiresAt: expiresAt.toISOString() })
  } catch {
    res.status(401).json({ error: 'Your email session is invalid or expired. Please sign in again.' })
  }
})

app.post('/api/auth/logout', async (req, res) => {
  const authorization = req.header('authorization') ?? ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (token && databaseAvailable()) {
    try {
      await ensureSchema()
      await query('DELETE FROM wallet_sessions WHERE token_hash = ?', [sha256(Buffer.from(token))])
    } catch { /* Expired sessions do not prevent logout in the browser. */ }
  }
  res.status(204).end()
})

app.post('/api/auth/challenge', processRateLimit('wallet-challenge', 20, 10 * 60_000), async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  const wallet = String(req.body?.wallet ?? '')
  if (!stellarAddress.test(wallet)) return res.status(400).json({ error: 'A valid Stellar wallet address is required' })
  const id = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 5 * 60_000)
  const message = `StellaNova sign-in\nWallet: ${wallet}\nChallenge: ${id}\nExpires: ${expiresAt.toISOString()}`
  try {
    await ensureSchema()
    await query('DELETE FROM wallet_auth_challenges WHERE expires_at <= now()')
    await query('INSERT INTO wallet_auth_challenges (challenge_id, wallet_address, message, expires_at) VALUES (?, ?, ?, ?)', [id, wallet, message, expiresAt])
    res.json({ challengeId: id, message })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not create sign-in challenge' })
  }
})

app.post('/api/auth/verify', processRateLimit('wallet-verify', 30, 10 * 60_000), async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  const challengeId = String(req.body?.challengeId ?? '')
  const wallet = String(req.body?.wallet ?? '')
  const signature = String(req.body?.signature ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !stellarAddress.test(wallet)) return res.status(401).json({ error: 'Sign-in challenge expired or invalid' })
  try {
    await ensureSchema()
    const challenge = await query<{ wallet_address: string; message: string }[]>('SELECT wallet_address, message FROM wallet_auth_challenges WHERE challenge_id = ? AND expires_at > now()', [challengeId])
    if (!challenge.length || challenge[0].wallet_address !== wallet) return res.status(401).json({ error: 'Sign-in challenge expired or invalid' })
    const keypair = StellarSdk.Keypair.fromPublicKey(wallet)
    const signatureBytes = Buffer.from(signature, 'base64')
    if (signatureBytes.length !== 64 || !keypair.verifyMessage(challenge[0].message, signatureBytes)) return res.status(401).json({ error: 'Wallet signature is invalid' })
    const freshAccount = await query<{ wallet_address: string }[]>('INSERT INTO wallet_accounts (wallet_address) VALUES (?) ON CONFLICT (wallet_address) DO NOTHING RETURNING wallet_address', [wallet])
    const firstAccountUse = freshAccount.length > 0 && !(await hasWalletHistory(wallet))
    if (firstAccountUse && /^[A-F0-9]{16}$/i.test(String(req.body?.referralCode ?? '').trim())) await query('INSERT INTO user_profiles (wallet_address) VALUES (?) ON CONFLICT (wallet_address) DO NOTHING', [wallet])
    const referralApplied = firstAccountUse ? await attributeNewWalletReferral(wallet, req.body?.referralCode) : false
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 12 * 60 * 60_000)
    const tokenHash = sha256(Buffer.from(token))
    const consumed = await query<{ challenge_id: string }[]>('DELETE FROM wallet_auth_challenges WHERE challenge_id = ? AND expires_at > now() RETURNING challenge_id', [challengeId])
    if (!consumed.length) return res.status(401).json({ error: 'Sign-in challenge was already used; try signing in again' })
    await query('INSERT INTO wallet_sessions (token_hash, wallet_address, expires_at) VALUES (?, ?, ?)', [tokenHash, wallet, expiresAt])
    res.json({ token, wallet, newAccount: firstAccountUse, referralApplied, expiresAt: expiresAt.toISOString() })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Wallet signature')) return res.status(401).json({ error: error.message })
    console.error('Wallet verification failed:', error)
    return res.status(503).json({ error: 'Could not verify wallet sign-in right now' })
  }
})

async function authenticatedWallet(req: express.Request): Promise<string | null> {
  const authorization = req.header('authorization') ?? ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!token || !databaseAvailable()) return null
  const sessions = await query<{ wallet_address: string }[]>('SELECT wallet_address FROM wallet_sessions WHERE token_hash = ? AND expires_at > now()', [sha256(Buffer.from(token))])
  return sessions[0]?.wallet_address ?? null
}

async function requireWallet(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  try {
    const wallet = await authenticatedWallet(req)
    if (!wallet) return res.status(401).json({ error: 'Sign in with your Stellar wallet first' })
    res.locals.wallet = wallet
    next()
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'Wallet session lookup failed' }) }
}

const stellarWalletPattern = /^G[A-Z2-7]{55}$/i
const validXlmAmount = (value: unknown) => {
  const amount = String(value ?? '').trim()
  return /^\d{1,8}(?:\.\d{1,7})?$/.test(amount) && Number(amount) > 0 && Number(amount) <= 10_000 ? amount : ''
}
const xlmStroops = (value: unknown) => {
  const amount = String(value ?? '').trim()
  if (!/^\d+(?:\.\d{1,7})?$/.test(amount)) return null
  const [whole, fraction = ''] = amount.split('.')
  try { return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0')) } catch { return null }
}
const safePublicUrl = (value: unknown) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  try { const parsed = new URL(raw); return ['http:', 'https:'].includes(parsed.protocol) && raw.length <= 2048 ? raw : null } catch { return null }
}

app.get('/api/creator-services', async (req, res) => {
  try {
    await ensureSchema()
    const category = String(req.query.category ?? '')
    const categoryFilter = ['commission', 'creative_service'].includes(category) ? category : null
    const items = await query<Record<string, unknown>[]>(
      `SELECT l.id, l.creator_wallet, COALESCE(a.creator_username, NULLIF(a.display_name,''), l.creator_wallet) AS creator_name,
        l.title, l.category, l.description, l.image_url, l.pricing_type, l.price_xlm::text AS price_xlm,
        l.availability, l.delivery_details, l.status, l.created_at
       FROM creator_service_listings l LEFT JOIN user_profiles a ON LOWER(a.wallet_address)=LOWER(l.creator_wallet)
       WHERE l.status IN ('published','sold') AND (?::text IS NULL OR l.category=?) ORDER BY l.created_at DESC LIMIT 100`,
      [categoryFilter, categoryFilter],
    )
    res.json({ items })
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load creator services' }) }
})
app.get('/api/creator-services/mine', requireWallet, async (_req,res) => {
  const wallet=res.locals.wallet as string
  await ensureSchema()
  const items=await query<Record<string,unknown>[]>(`SELECT l.id,l.creator_wallet,COALESCE(p.creator_username,NULLIF(p.display_name,''),l.creator_wallet) AS creator_name,l.title,l.category,l.description,l.image_url,l.pricing_type,l.price_xlm::text AS price_xlm,l.availability,l.delivery_details,l.status,l.created_at FROM creator_service_listings l LEFT JOIN user_profiles p ON LOWER(p.wallet_address)=LOWER(l.creator_wallet) WHERE LOWER(l.creator_wallet)=LOWER(?) ORDER BY l.created_at DESC LIMIT 100`,[wallet])
  res.json({items})
})

app.post('/api/creator-services', processRateLimit('creator-service-create', 6, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const { title, category, description, imageUrl, pricingType, priceXlm, availability, deliveryDetails } = req.body ?? {}
  const cleanTitle = String(title ?? '').trim()
  const cleanDescription = String(description ?? '').trim()
  const validCategory = ['commission', 'creative_service'].includes(category)
  const validPricing = ['quote', 'starting_at', 'fixed'].includes(pricingType)
  const amount = validXlmAmount(priceXlm)
  const portfolioUrl = safePublicUrl(imageUrl)
  if (imageUrl && !portfolioUrl) return res.status(400).json({ error: 'Portfolio images must use a valid http or https URL.' })
  if (cleanTitle.length < 3 || cleanTitle.length > 120 || cleanDescription.length < 20 || cleanDescription.length > 3000 || !validCategory || !validPricing || ((pricingType === 'fixed' || pricingType === 'starting_at') && !amount)) return res.status(400).json({ error: 'Check the title, 20–3,000 character description, service type, and XLM price.' })
  await ensureSchema()
  const result = await query<{ id: number }[]>(
    `INSERT INTO creator_service_listings (creator_wallet,title,category,description,image_url,pricing_type,price_xlm,availability,delivery_details)
     VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
    [wallet, cleanTitle, category, cleanDescription, portfolioUrl, pricingType, amount || null, String(availability ?? 'available').slice(0, 32), String(deliveryDetails ?? '').slice(0, 1000)],
  )
  res.status(201).json({ id: result[0]?.id })
})

app.patch('/api/creator-services/:id', processRateLimit('creator-service-update', 20, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const id = Number(req.params.id)
  const status = String(req.body?.status ?? '')
  if (!Number.isSafeInteger(id) || id <= 0 || !['published', 'paused'].includes(status)) return res.status(400).json({ error: 'Invalid listing update' })
  const updated = await query<{ id: number }[]>(`UPDATE creator_service_listings SET status=?, updated_at=now() WHERE id=? AND LOWER(creator_wallet)=LOWER(?) AND status <> 'sold' RETURNING id`, [status, id, wallet])
  if (!updated.length) return res.status(404).json({ error: 'Listing not found or already sold' })
  res.json({ ok: true })
})

app.get('/api/creator-service-requests', requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  await ensureSchema()
  const items = await query<Record<string, unknown>[]>(
    `SELECT r.id, r.listing_id, r.buyer_wallet, r.creator_wallet, r.brief, r.delivery_address, r.status,
      r.agreed_amount_xlm::text AS agreed_amount_xlm, r.transaction_hash, r.creator_note, r.created_at,
      l.title, l.category, l.pricing_type, l.price_xlm::text AS listing_price_xlm
     FROM creator_service_requests r JOIN creator_service_listings l ON l.id=r.listing_id
     WHERE LOWER(r.buyer_wallet)=LOWER(?) OR LOWER(r.creator_wallet)=LOWER(?) ORDER BY r.created_at DESC LIMIT 100`, [wallet, wallet],
  )
  res.json({ items })
})

app.post('/api/creator-service-requests', processRateLimit('creator-service-request', 10, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const listingId = Number(req.body?.listingId)
  const brief = String(req.body?.brief ?? '').trim()
  const deliveryAddress = String(req.body?.deliveryAddress ?? '').trim()
  if (!Number.isSafeInteger(listingId) || listingId <= 0 || brief.length < 10 || brief.length > 3000 || deliveryAddress.length > 1000) return res.status(400).json({ error: 'Add a request brief between 10 and 3,000 characters.' })
  await ensureSchema()
  const listing = await query<{ creator_wallet: string; category: string; status: string }[]>(`SELECT creator_wallet, category, status FROM creator_service_listings WHERE id=?`, [listingId])
  if (!listing.length || listing[0].status !== 'published') return res.status(404).json({ error: 'This listing is unavailable.' })
  if (listing[0].creator_wallet.toLowerCase() === wallet.toLowerCase()) return res.status(400).json({ error: 'You cannot request your own listing.' })
  const created = await query<{ id: number }[]>(`INSERT INTO creator_service_requests (listing_id,buyer_wallet,creator_wallet,brief,delivery_address) VALUES (?,?,?,?,?) RETURNING id`, [listingId, wallet, listing[0].creator_wallet, brief, null])
  await query(`INSERT INTO notifications (wallet_address,kind,title,body,action_url) VALUES (?,?,?,?,?)`, [listing[0].creator_wallet, 'service_request', 'New creator service request', 'A buyer sent a request. Review the brief and set the XLM terms.', '/services'])
  res.status(201).json({ id: created[0]?.id })
})

app.patch('/api/creator-service-requests/:id', processRateLimit('creator-service-request-update', 20, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const id = Number(req.params.id)
  const action = String(req.body?.action ?? '')
  if (!Number.isSafeInteger(id) || id <= 0 || !['accept', 'decline', 'in_progress', 'shipped', 'delivered', 'complete'].includes(action)) return res.status(400).json({ error: 'Invalid request update' })
  await ensureSchema()
  const rows = await query<{ creator_wallet: string; buyer_wallet: string; status: string; listing_id: number; category: string; pricing_type: string; price_xlm: string | null }[]>(`SELECT r.creator_wallet,r.buyer_wallet,r.status,r.listing_id,l.category,l.pricing_type,l.price_xlm::text FROM creator_service_requests r JOIN creator_service_listings l ON l.id=r.listing_id WHERE r.id=?`, [id])
  if (!rows.length) return res.status(404).json({ error: 'Request not found' })
  const row = rows[0]
  const creator = row.creator_wallet.toLowerCase() === wallet.toLowerCase()
  const buyer = row.buyer_wallet.toLowerCase() === wallet.toLowerCase()
  const note = String(req.body?.note ?? '').trim().slice(0, 1000)
  if (action === 'accept' || action === 'decline') {
    if (!creator || row.status !== 'requested') return res.status(403).json({ error: 'Only the creator can respond to a pending request.' })
    if (action === 'decline') {
      const changed=await query<{id:number}[]>(`UPDATE creator_service_requests SET status='declined',creator_note=?,updated_at=now() WHERE id=? AND status='requested' RETURNING id`,[note,id])
      if (!changed.length) return res.status(409).json({ error: 'This request has already changed.' })
    }
    else {
      const amount = validXlmAmount(req.body?.amountXlm ?? row.price_xlm)
      if (!amount || (row.pricing_type === 'fixed' && row.price_xlm && xlmStroops(amount) !== xlmStroops(row.price_xlm))) return res.status(400).json({ error: 'Set a valid XLM quote. Fixed-price listings must use the listed amount.' })
      const changed=await query<{id:number}[]>(`UPDATE creator_service_requests SET status='accepted',agreed_amount_xlm=?,creator_note=?,updated_at=now() WHERE id=? AND status='requested' RETURNING id`,[amount,note,id])
      if (!changed.length) return res.status(409).json({ error: 'This request has already changed.' })
    }
  } else if (action === 'in_progress' || action === 'shipped' || action === 'delivered') {
    if (!creator || !['paid','in_progress'].includes(row.status) || action === 'shipped') return res.status(403).json({ error: 'This service status update is not available for this request.' })
    const allowed=action==='in_progress' ? ['paid'] : ['paid','in_progress']
    const changed=await query<{id:number}[]>(`UPDATE creator_service_requests SET status=?,creator_note=?,updated_at=now() WHERE id=? AND status=ANY(?) RETURNING id`,[action,note,id,allowed])
    if (!changed.length) return res.status(409).json({ error: 'This request has already changed.' })
  } else {
    if (!buyer || row.status !== 'delivered') return res.status(403).json({ error: 'Only the buyer can complete a delivered order.' })
    const changed=await query<{id:number}[]>(`UPDATE creator_service_requests SET status='completed',updated_at=now() WHERE id=? AND status='delivered' RETURNING id`,[id])
    if (!changed.length) return res.status(409).json({ error: 'This request has already changed.' })
  }
  const recipient = creator ? row.buyer_wallet : row.creator_wallet
  await query(`INSERT INTO notifications (wallet_address,kind,title,body,action_url) VALUES (?,?,?,?,?)`, [recipient, 'service_request_update', 'Creator request updated', 'A creator service request has a new status.', '/services'])
  res.json({ ok: true })
})

app.post('/api/creator-service-requests/:id/payment', processRateLimit('creator-service-payment', 10, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const id = Number(req.params.id)
  const txHash = String(req.body?.transactionHash ?? '').trim().toLowerCase()
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-f0-9]{64}$/.test(txHash)) return res.status(400).json({ error: 'A valid Stellar transaction hash is required.' })
  await ensureSchema()
  const rows = await query<{ creator_wallet: string; buyer_wallet: string; status: string; amount: string; listing_id: number; category: string }[]>(`SELECT creator_wallet,buyer_wallet,status,agreed_amount_xlm::text AS amount,listing_id,category FROM creator_service_requests r JOIN creator_service_listings l ON l.id=r.listing_id WHERE r.id=?`, [id])
  if (!rows.length || rows[0].buyer_wallet.toLowerCase() !== wallet.toLowerCase()) return res.status(404).json({ error: 'Accepted request not found.' })
  const order = rows[0]
  if (order.status !== 'accepted' || !order.amount) return res.status(409).json({ error: 'This request is not ready for payment.' })
  const network = String(process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase()
  const horizon = network === 'PUBLIC' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org'
  try {
    const txResponse = await fetch(`${horizon}/transactions/${txHash}`, { signal: AbortSignal.timeout(10_000) })
    if (!txResponse.ok) return res.status(409).json({ error: 'Payment is not confirmed on the configured Stellar network yet.' })
    const tx = await txResponse.json() as { successful?: boolean; source_account?: string; memo_type?: string; memo?: string; ledger?: number }
    if (tx.successful !== true || tx.source_account?.toLowerCase() !== wallet.toLowerCase() || tx.memo_type !== 'text' || tx.memo !== `SN order ${id}`) return res.status(400).json({ error: 'This transaction does not match this order payment.' })
    const opResponse = await fetch(`${horizon}/transactions/${txHash}/operations?limit=10`, { signal: AbortSignal.timeout(10_000) })
    if (!opResponse.ok) return res.status(503).json({ error: 'Could not verify the payment operation yet.' })
    const opData = await opResponse.json() as { _embedded?: { records?: { type?: string; from?: string; to?: string; amount?: string; asset_type?: string; source_account?: string }[] } }
    const operations = opData._embedded?.records ?? []
    const payment = operations[0]
    if (operations.length !== 1 || payment?.type !== 'payment' || payment.asset_type !== 'native' || payment.to?.toLowerCase() !== order.creator_wallet.toLowerCase() || (payment.from ?? payment.source_account)?.toLowerCase() !== wallet.toLowerCase() || xlmStroops(payment.amount) === null || xlmStroops(payment.amount) !== xlmStroops(order.amount)) return res.status(400).json({ error: 'The confirmed payment must be the exact XLM amount for this creator and order.' })
    await withTransaction(async () => {
      const locked = await query<{ status: string }[]>(`SELECT status FROM creator_service_requests WHERE id=? FOR UPDATE`, [id])
      if (!locked.length || locked[0].status !== 'accepted') throw new Error('This order has already been paid or changed.')
      await query(`UPDATE creator_service_requests SET status='paid',transaction_hash=?,updated_at=now() WHERE id=?`, [txHash, id])
      await query(`INSERT INTO creator_commerce_payments (transaction_hash,payer_wallet,payee_wallet,order_kind,order_id,amount_xlm) VALUES (?,?,?,?,?,?)`, [txHash,wallet,order.creator_wallet,'service',id,order.amount])
      await query(`INSERT INTO notifications (wallet_address,kind,title,body,action_url) VALUES (?,?,?,?,?)`, [order.creator_wallet, 'service_payment', 'XLM payment received', `${order.amount} XLM was paid for your creator listing.`, '/services'])
    })
    res.status(201).json({ ok: true, transactionHash: txHash })
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Could not verify this payment.' }) }
})

app.get('/api/physical-art', async (_req, res) => {
  try {
    await ensureSchema()
    const items = await query<Record<string, unknown>[]>(`SELECT l.id,l.creator_wallet,COALESCE(p.creator_username,NULLIF(p.display_name,''),l.creator_wallet) AS creator_name,l.title,l.description,l.image_url,l.price_xlm::text AS price_xlm,l.dimensions,l.medium,l.delivery_details,l.status,l.created_at FROM physical_art_listings l LEFT JOIN user_profiles p ON LOWER(p.wallet_address)=LOWER(l.creator_wallet) WHERE l.status IN ('published','sold') ORDER BY l.created_at DESC LIMIT 100`)
    res.json({ items })
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load original physical artworks' }) }
})
app.get('/api/physical-art/mine', requireWallet, async (_req,res) => {
  const wallet=res.locals.wallet as string
  await ensureSchema()
  const items=await query<Record<string,unknown>[]>(`SELECT l.id,l.creator_wallet,COALESCE(p.creator_username,NULLIF(p.display_name,''),l.creator_wallet) AS creator_name,l.title,l.description,l.image_url,l.price_xlm::text AS price_xlm,l.dimensions,l.medium,l.delivery_details,l.status,l.created_at FROM physical_art_listings l LEFT JOIN user_profiles p ON LOWER(p.wallet_address)=LOWER(l.creator_wallet) WHERE LOWER(l.creator_wallet)=LOWER(?) ORDER BY l.created_at DESC LIMIT 100`,[wallet])
  res.json({items})
})

app.post('/api/physical-art', processRateLimit('physical-art-create', 6, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const input = req.body ?? {}
  const title = String(input.title ?? '').trim(), description = String(input.description ?? '').trim(), imageUrl = safePublicUrl(input.imageUrl), price = validXlmAmount(input.priceXlm)
  if (title.length < 3 || title.length > 160 || description.length < 30 || description.length > 4000 || !price || !imageUrl) return res.status(400).json({ error: 'Add a title, a 30–4,000 character description, artwork image URL, and fixed XLM price.' })
  await ensureSchema()
  const inserted = await query<{ id: number }[]>(`INSERT INTO physical_art_listings (creator_wallet,title,description,image_url,price_xlm,dimensions,medium,delivery_details) VALUES (?,?,?,?,?,?,?,?) RETURNING id`, [wallet,title,description,imageUrl,price,String(input.dimensions ?? '').slice(0,120),String(input.medium ?? '').slice(0,120),String(input.deliveryDetails ?? '').trim().slice(0,1000)])
  res.status(201).json({ id: inserted[0]?.id })
})

app.patch('/api/physical-art/:id', processRateLimit('physical-art-update', 20, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string, id = Number(req.params.id), status = String(req.body?.status ?? '')
  if (!Number.isSafeInteger(id) || id <= 0 || !['published','paused'].includes(status)) return res.status(400).json({ error: 'Invalid physical artwork update' })
  const updated = await query<{ id: number }[]>(`UPDATE physical_art_listings SET status=?,updated_at=now() WHERE id=? AND LOWER(creator_wallet)=LOWER(?) AND status <> 'sold' RETURNING id`, [status,id,wallet])
  if (!updated.length) return res.status(404).json({ error: 'Artwork not found or already sold' })
  res.json({ ok: true })
})

app.get('/api/physical-art/orders', requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  await ensureSchema()
  const items = await query<Record<string, unknown>[]>(`SELECT o.id,o.listing_id,o.buyer_wallet,o.seller_wallet,o.delivery_address,o.status,o.transaction_hash,o.tracking_note,o.created_at,l.title,l.price_xlm::text AS price_xlm,l.image_url FROM physical_art_orders o JOIN physical_art_listings l ON l.id=o.listing_id WHERE LOWER(o.buyer_wallet)=LOWER(?) OR LOWER(o.seller_wallet)=LOWER(?) ORDER BY o.created_at DESC LIMIT 100`, [wallet,wallet])
  res.json({ items })
})

app.post('/api/physical-art/:id/orders', processRateLimit('physical-art-order', 10, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string, id = Number(req.params.id), deliveryAddress = String(req.body?.deliveryAddress ?? '').trim()
  if (!Number.isSafeInteger(id) || id <= 0 || deliveryAddress.length < 8 || deliveryAddress.length > 1500) return res.status(400).json({ error: 'Enter the delivery address for this physical artwork.' })
  await ensureSchema()
  const listing = await query<{ creator_wallet: string; status: string }[]>(`SELECT creator_wallet,status FROM physical_art_listings WHERE id=?`, [id])
  if (!listing.length || listing[0].status !== 'published') return res.status(409).json({ error: 'This physical artwork is no longer available.' })
  if (listing[0].creator_wallet.toLowerCase() === wallet.toLowerCase()) return res.status(400).json({ error: 'You cannot buy your own artwork.' })
  const result = await withTransaction(async () => {
    const locked = await query<{status:string}[]>(`SELECT status FROM physical_art_listings WHERE id=? FOR UPDATE`,[id])
    if (!locked.length || locked[0].status !== 'published') throw new Error('This physical artwork is no longer available.')
    const pending = await query<{id:number}[]>(`SELECT id FROM physical_art_orders WHERE listing_id=? AND status='pending' LIMIT 1`,[id])
    if (pending.length) throw new Error('Another buyer has an unpaid order. Ask them to complete or cancel it before ordering.')
    return query<{ id: number }[]>(`INSERT INTO physical_art_orders (listing_id,buyer_wallet,seller_wallet,delivery_address) VALUES (?,?,?,?) RETURNING id`, [id,wallet,listing[0].creator_wallet,deliveryAddress])
  })
  await query(`INSERT INTO notifications (wallet_address,kind,title,body,action_url) VALUES (?,?,?,?,?)`, [listing[0].creator_wallet,'physical_art_order','Physical artwork order requested','A buyer wants to purchase your original artwork. Review the order.','/physical-art'])
  res.status(201).json({ id: result[0]?.id })
})

app.post('/api/physical-art/orders/:id/payment', processRateLimit('physical-art-payment', 10, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string, id = Number(req.params.id), txHash = String(req.body?.transactionHash ?? '').trim().toLowerCase()
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-f0-9]{64}$/.test(txHash)) return res.status(400).json({ error: 'A valid Stellar transaction hash is required.' })
  await ensureSchema()
  const rows = await query<{ buyer_wallet: string; seller_wallet: string; status: string; listing_id: number; price: string }[]>(`SELECT o.buyer_wallet,o.seller_wallet,o.status,o.listing_id,l.price_xlm::text AS price FROM physical_art_orders o JOIN physical_art_listings l ON l.id=o.listing_id WHERE o.id=?`, [id])
  if (!rows.length || rows[0].buyer_wallet.toLowerCase() !== wallet.toLowerCase()) return res.status(404).json({ error: 'Physical art order not found.' })
  const order = rows[0]
  if (order.status !== 'pending') return res.status(409).json({ error: 'This order is no longer awaiting payment.' })
  const network = String(process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase(), horizon = network === 'PUBLIC' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org'
  try {
    const txResponse = await fetch(`${horizon}/transactions/${txHash}`, { signal: AbortSignal.timeout(10_000) })
    if (!txResponse.ok) return res.status(409).json({ error: 'Payment is not confirmed on the configured Stellar network yet.' })
    const tx = await txResponse.json() as { successful?: boolean; source_account?: string; memo_type?: string; memo?: string }
    if (!tx.successful || tx.source_account?.toLowerCase() !== wallet.toLowerCase() || tx.memo_type !== 'text' || tx.memo !== `SN order ${id}`) return res.status(400).json({ error: 'This transaction does not match this physical artwork order.' })
    const opResponse = await fetch(`${horizon}/transactions/${txHash}/operations?limit=10`, { signal: AbortSignal.timeout(10_000) })
    if (!opResponse.ok) return res.status(503).json({ error: 'Could not verify the payment operation yet.' })
    const opData = await opResponse.json() as { _embedded?: { records?: { type?: string; from?: string; to?: string; amount?: string; asset_type?: string; source_account?: string }[] } }
    const operations = opData._embedded?.records ?? [], payment = operations[0]
    if (operations.length !== 1 || payment?.type !== 'payment' || payment.asset_type !== 'native' || payment.to?.toLowerCase() !== order.seller_wallet.toLowerCase() || (payment.from ?? payment.source_account)?.toLowerCase() !== wallet.toLowerCase() || xlmStroops(payment.amount) === null || xlmStroops(payment.amount) !== xlmStroops(order.price)) return res.status(400).json({ error: 'The confirmed payment must be the exact XLM price sent to this artist.' })
    await withTransaction(async () => {
      const locked = await query<{ status: string }[]>(`SELECT status FROM physical_art_orders WHERE id=? FOR UPDATE`, [id])
      const item = await query<{ status: string }[]>(`SELECT status FROM physical_art_listings WHERE id=? FOR UPDATE`, [order.listing_id])
      if (!locked.length || locked[0].status !== 'pending' || !item.length || item[0].status !== 'published') throw new Error('This artwork was already reserved or sold.')
      await query(`UPDATE physical_art_orders SET status='paid',transaction_hash=?,updated_at=now() WHERE id=?`, [txHash,id])
      await query(`UPDATE physical_art_listings SET status='sold',updated_at=now() WHERE id=?`, [order.listing_id])
      await query(`INSERT INTO creator_commerce_payments (transaction_hash,payer_wallet,payee_wallet,order_kind,order_id,amount_xlm) VALUES (?,?,?,?,?,?)`, [txHash,wallet,order.seller_wallet,'physical_art',id,order.price])
      await query(`INSERT INTO notifications (wallet_address,kind,title,body,action_url) VALUES (?,?,?,?,?)`, [order.seller_wallet,'physical_art_payment','Physical artwork paid','The buyer paid the listed XLM price. Arrange delivery and update the order.','/physical-art'])
    })
    res.status(201).json({ ok: true, transactionHash: txHash })
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Could not verify this payment.' }) }
})

app.patch('/api/physical-art/orders/:id', processRateLimit('physical-art-order-update', 20, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string, id = Number(req.params.id), action = String(req.body?.action ?? '')
  if (!Number.isSafeInteger(id) || id <= 0 || !['shipped','delivered','complete','cancel'].includes(action)) return res.status(400).json({ error: 'Invalid order update' })
  const rows = await query<{ buyer_wallet: string; seller_wallet: string; status: string }[]>(`SELECT buyer_wallet,seller_wallet,status FROM physical_art_orders WHERE id=?`, [id])
  if (!rows.length) return res.status(404).json({ error: 'Order not found' })
  const order = rows[0], seller = order.seller_wallet.toLowerCase() === wallet.toLowerCase(), buyer = order.buyer_wallet.toLowerCase() === wallet.toLowerCase()
  let changed: {id:number}[] = []
  if (action === 'cancel' && buyer && order.status === 'pending') changed=await query<{id:number}[]>(`UPDATE physical_art_orders SET status='cancelled',updated_at=now() WHERE id=? AND status='pending' RETURNING id`, [id])
  else if (seller && ['shipped','delivered'].includes(action) && ['paid','shipped'].includes(order.status)) changed=await query<{id:number}[]>(`UPDATE physical_art_orders SET status=?,tracking_note=?,updated_at=now() WHERE id=? AND status IN ('paid','shipped') RETURNING id`, [action,String(req.body?.note ?? '').trim().slice(0,1000),id])
  else if (buyer && action === 'complete' && order.status === 'delivered') changed=await query<{id:number}[]>(`UPDATE physical_art_orders SET status='completed',updated_at=now() WHERE id=? AND status='delivered' RETURNING id`, [id])
  else return res.status(403).json({ error: 'This order action is not available to your account at its current status.' })
  if (!changed.length) return res.status(409).json({ error: 'This order has already changed.' })
  const recipient = seller ? order.buyer_wallet : order.seller_wallet
  await query(`INSERT INTO notifications (wallet_address,kind,title,body,action_url) VALUES (?,?,?,?,?)`, [recipient,'physical_art_order_update','Physical artwork order updated','Your original artwork order has a new status.','/physical-art'])
  res.json({ ok: true })
})

app.get('/api/exhibitions', async (req, res) => {
  try {
    await ensureSchema()
    const scope = String(req.query.scope ?? 'upcoming')
    const items = await query<Record<string, unknown>[]>(`SELECT e.*, COALESCE(a.creator_username,NULLIF(a.display_name,''),e.organizer_wallet) AS organizer_name FROM creator_exhibitions e LEFT JOIN user_profiles a ON LOWER(a.wallet_address)=LOWER(e.organizer_wallet) WHERE e.status='published' AND (? <> 'upcoming' OR e.ends_at >= now()) AND (? <> 'past' OR e.ends_at < now()) ORDER BY CASE WHEN e.starts_at >= now() THEN 0 ELSE 1 END,e.starts_at ASC LIMIT 100`, [scope, scope])
    res.json({ items })
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load exhibitions' }) }
})

app.post('/api/exhibitions', processRateLimit('exhibition-create', 8, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const input = req.body ?? {}
  const title = String(input.title ?? '').trim(), description = String(input.description ?? '').trim(), venue = String(input.venue ?? '').trim(), address = String(input.streetAddress ?? '').trim(), city = String(input.city ?? '').trim(), country = String(input.country ?? '').trim()
  const start = new Date(input.startsAt), end = new Date(input.endsAt)
  if (title.length < 3 || title.length > 160 || description.length < 30 || description.length > 4000 || !venue || !address || !city || !country || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return res.status(400).json({ error: 'Add the event title, detailed description, full venue address, and valid start/end dates.' })
  const url = (value: unknown) => { const raw = String(value ?? '').trim(); if (!raw) return null; try { const parsed = new URL(raw); return ['http:', 'https:'].includes(parsed.protocol) ? raw.slice(0, 2048) : null } catch { return null } }
  const website = url(input.websiteUrl), tickets = url(input.ticketUrl), imageUrl = safePublicUrl(input.imageUrl)
  if ((input.websiteUrl && !website) || (input.ticketUrl && !tickets)) return res.status(400).json({ error: 'Website and ticket links must be valid http or https URLs.' })
  if (input.imageUrl && !imageUrl) return res.status(400).json({ error: 'Exhibition image must use a valid http or https URL.' })
  await ensureSchema()
  const inserted = await query<{ id: number }[]>(`INSERT INTO creator_exhibitions (organizer_wallet,title,description,venue,street_address,city,region,country,starts_at,ends_at,website_url,ticket_url,image_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, [wallet,title,description,venue,address,city,String(input.region ?? '').slice(0,120),country,start.toISOString(),end.toISOString(),website,tickets,imageUrl])
  res.status(201).json({ id: inserted[0]?.id })
})

app.patch('/api/exhibitions/:id', processRateLimit('exhibition-update', 20, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const id = Number(req.params.id)
  const status = String(req.body?.status ?? '')
  if (!Number.isSafeInteger(id) || id <= 0 || !['published','cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid exhibition update' })
  const updated = await query<{ id: number }[]>(`UPDATE creator_exhibitions SET status=?,updated_at=now() WHERE id=? AND LOWER(organizer_wallet)=LOWER(?) RETURNING id`, [status,id,wallet])
  if (!updated.length) return res.status(404).json({ error: 'Exhibition not found' })
  res.json({ ok: true })
})

app.get('/api/creator/archive', requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  try {
    await ensureSchema()
    const items = await query<{ collection_slug: string; name: string; symbol: string; total_supply: number | null; artwork_count: number; archived_at: string }[]>(
      `SELECT a.collection_slug, c.name, c.symbol, c.total_supply, a.artwork_count, a.archived_at
       FROM creator_collection_archive a
       JOIN collections c ON c.slug = a.collection_slug AND LOWER(c.owner_wallet) = LOWER(a.wallet_address)
       WHERE LOWER(a.wallet_address) = LOWER(?)
       ORDER BY a.archived_at DESC`,
      [wallet],
    )
    res.json({ items })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load your archive' })
  }
})

app.post('/api/creator/archive', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const collectionSlug = String(req.body?.collectionSlug ?? '').trim().toLowerCase()
  const artworkCount = Math.max(0, Math.min(10_000, Math.floor(Number(req.body?.artworkCount) || 0)))
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(collectionSlug)) return res.status(400).json({ error: 'A valid collection is required' })
  try {
    await ensureSchema()
    const items = await query<{ collection_slug: string; name: string; symbol: string; total_supply: number | null; artwork_count: number; archived_at: string }[]>(
      `INSERT INTO creator_collection_archive (wallet_address, collection_slug, artwork_count)
       SELECT owner_wallet, slug, ? FROM collections
       WHERE LOWER(owner_wallet) = LOWER(?) AND slug = ? AND contract_id IS NOT NULL
       ON CONFLICT (wallet_address, collection_slug) DO UPDATE
       SET artwork_count = EXCLUDED.artwork_count, archived_at = now()
       RETURNING collection_slug, artwork_count, archived_at`,
      [artworkCount, wallet, collectionSlug],
    )
    if (!items.length) return res.status(404).json({ error: 'That created collection could not be found in your account' })
    const collection = await query<{ name: string; symbol: string; total_supply: number | null }[]>(
      'SELECT name, symbol, total_supply FROM collections WHERE slug = ? AND LOWER(owner_wallet) = LOWER(?) LIMIT 1',
      [collectionSlug, wallet],
    )
    res.json({ item: { ...items[0], ...collection[0] } })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not save this collection to your archive' })
  }
})

async function notifyOfferWallet(wallet: string, kind: string, title: string, body: string, emailSubject: string, actionUrl?: string) {
  let notificationPath = '/account'
  if (actionUrl) {
    try { notificationPath = new URL(actionUrl).pathname } catch { /* Keep the safe account destination. */ }
  }
  await notifyUser(wallet, kind, title, body, notificationPath)
  if (!mailConfigured()) return
  const profile = await query<{ email: string | null }[]>('SELECT email FROM user_profiles WHERE LOWER(wallet_address) = LOWER(?) LIMIT 1', [wallet])
  const email = profile[0]?.email?.trim()
  if (email) {
    const content = marketplaceEmail(emailSubject, body, actionUrl ?? 'https://stellanova-fawn.vercel.app/account', actionUrl ? 'View NFT on StellaNova' : 'Review marketplace activity')
    await sendMail({ to: email, subject: emailSubject, ...content })
  }
}

async function marketplaceNftEmailContext(contractId: string, tokenId: number) {
  const rows = await query<{ title: string | null }[]>(
    `SELECT COALESCE(NULLIF(m.title, ''), NULLIF(n.name, ''), NULLIF(s.metadata_name, ''), NULLIF(c.name, '')) AS title
     FROM (SELECT ?::varchar AS contract_id, ?::int AS token_id) ref
     LEFT JOIN nft_mints m ON LOWER(m.contract_id) = LOWER(ref.contract_id) AND m.token_id = ref.token_id
     LEFT JOIN canonical_metadata cm ON LOWER(cm.contract_id) = LOWER(ref.contract_id) AND cm.token_id = ref.token_id
     LEFT JOIN creator_nft_metadata n ON n.metadata_uri = COALESCE(m.metadata_uri, cm.metadata_uri)
     LEFT JOIN mint_stages s ON s.id = m.stage_id
     LEFT JOIN collections c ON c.slug = COALESCE(m.collection_id, n.collection_id)`,
    [contractId, tokenId],
  )
  const appUrl = (process.env.PUBLIC_APP_URL ?? process.env.APP_URL ?? 'https://stellanova-fawn.vercel.app').replace(/\/$/, '')
  return {
    title: rows[0]?.title?.trim() || `NFT #${tokenId}`,
    url: new URL(`/nft/${encodeURIComponent(`minted-${contractId.toLowerCase()}-${tokenId}`)}`, appUrl).toString(),
  }
}

async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  let wallet: string | null
  try { wallet = await authenticatedWallet(req) } catch (error) { return res.status(503).json({ error: error instanceof Error ? error.message : 'Wallet session lookup failed' }) }
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  if (!wallet) return res.status(401).json({ error: 'Sign in with your Stellar wallet first' })
  try {
    const rows = await query<{ is_admin: boolean }[]>('SELECT is_admin FROM user_profiles WHERE wallet_address = ?', [wallet])
    if (!rows.length || !rows[0].is_admin) return res.status(403).json({ error: 'Administrator authorization required' })
    res.locals.wallet = wallet
    next()
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Admin check failed' })
  }
}

app.get('/api/health/live', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Minimal platform readiness probe. Keep dependency details private; the
// authenticated operations endpoint reports database, RPC and indexer health.
app.get('/api/health/ready', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const database = await checkDatabaseConnection()
  if (!database.ok) return res.status(503).json({ status: 'not_ready' })
  res.json({ status: 'ready' })
})

const opsAlertFallbackState = new Map<string, { status: 'degraded' | 'recovered'; sentAt: number }>()

async function deliverOpsAlert(status: 'degraded' | 'recovered', summary: string, alertKey = 'readiness') {
  let shouldSend = false
  let persistentStateAvailable = false
  try {
    await ensureSchema()
    const previous = await query<{ status: string }[]>('SELECT status FROM ops_alert_state WHERE alert_key = ?', [alertKey])
    if (status === 'recovered' && previous[0]?.status !== 'degraded') return { sent: false, reason: 'no_prior_degraded_state' }
    const due = await query<{ alert_key: string }[]>(
      `INSERT INTO ops_alert_state (alert_key, status, last_sent_at, last_result)
       VALUES (?, ?, now(), 'pending')
       ON CONFLICT (alert_key) DO UPDATE SET status=EXCLUDED.status, last_sent_at=now(), last_result='pending'
       WHERE ops_alert_state.status IS DISTINCT FROM EXCLUDED.status
          OR (EXCLUDED.status = 'degraded' AND ops_alert_state.last_sent_at < now() - interval '30 minutes')
       RETURNING alert_key`,
      [alertKey, status],
    )
    persistentStateAvailable = true
    shouldSend = due.length > 0
  } catch {
    const previous = opsAlertFallbackState.get(alertKey)
    shouldSend = status === 'degraded'
      ? !previous || previous.status !== 'degraded' || Date.now() - previous.sentAt >= 30 * 60_000
      : previous?.status === 'degraded'
  }
  if (!shouldSend) return { sent: false, reason: 'suppressed_by_policy' }
  const text = `StellaNova operations: ${status}\n${summary}\nChecked: ${new Date().toISOString()}`
  const webhook = process.env.OPS_ALERT_WEBHOOK_URL
  let webhookSent = false
  if (webhook && /^https:\/\//i.test(webhook)) {
    try {
      const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) })
      webhookSent = response.ok
    } catch { webhookSent = false }
  }
  const recipient = process.env.OPS_ALERT_EMAIL ?? 'akintoyeisaac5@gmail.com'
  const email = mailConfigured() ? await sendMail({
    to: recipient,
    subject: `StellaNova operations ${status}`,
    text,
    html: `<!doctype html><html><body style="font:15px Arial,sans-serif;background:#f5f3f8;padding:24px;color:#211d29"><main style="max-width:560px;margin:auto;background:white;border:1px solid #e9e5ef;border-radius:14px;padding:24px"><div style="font-size:12px;letter-spacing:1.2px;color:#7253dc;font-weight:700">STELLANOVA · OPERATIONS</div><h1 style="font-size:22px">System ${status}</h1><p>${summary.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)}</p><small>Checked ${new Date().toISOString()}</small></main></body></html>`,
  }) : { sent: false }
  const sent = webhookSent || email.sent
  opsAlertFallbackState.set(alertKey, { status, sentAt: Date.now() })
  if (persistentStateAvailable) {
    await query('UPDATE ops_alert_state SET last_result = ? WHERE alert_key = ?', [sent ? 'delivered' : 'delivery_unconfigured_or_failed', alertKey]).catch(() => undefined)
  }
  const result = { sent, webhookSent, emailSent: email.sent }
  console.log(JSON.stringify({ event: 'ops_alert_delivery', status, ...result }))
  return result
}

app.get('/api/admin/ops/health', requireAdmin, async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const database = await checkDatabaseConnection()
  const rpcUrl = process.env.STELLAR_RPC_URL ?? process.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'
  let rpc: { ok: boolean; latencyMs?: number; latestLedger?: number } = { ok: false }
  const rpcStartedAt = Date.now()
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ops-health', method: 'getLatestLedger', params: {} }),
      signal: AbortSignal.timeout(5_000),
    })
    const payload = await response.json() as { result?: { sequence?: number | string }; error?: unknown }
    const latestLedger = Number(payload.result?.sequence)
    if (!response.ok || payload.error || !Number.isSafeInteger(latestLedger) || latestLedger <= 0) throw new Error('Soroban RPC probe failed')
    rpc = { ok: true, latencyMs: Date.now() - rpcStartedAt, latestLedger }
  } catch {
    rpc = { ok: false, latencyMs: Date.now() - rpcStartedAt }
  }

  const [indexer, checkpoint] = await Promise.all([Promise.resolve(indexerStatus()), readIndexerCheckpoint()])
  const indexedThrough = checkpoint ? Math.max(0, checkpoint.nextLedger - 1) : null
  const lagLedgers = rpc.latestLedger && indexedThrough !== null ? Math.max(0, rpc.latestLedger - indexedThrough) : null
  const configuredLagLimit = Number(process.env.OPS_INDEXER_LAG_ALERT_LEDGERS ?? 5_000)
  const lagLimit = Number.isSafeInteger(configuredLagLimit) && configuredLagLimit > 0 ? configuredLagLimit : 5_000
  const lastRunAgeMs = checkpoint ? Math.max(0, Date.now() - Date.parse(checkpoint.updatedAt)) : null
  const configuredMaxAge = Number(process.env.OPS_INDEXER_MAX_AGE_MS ?? 120_000)
  const maxAgeMs = Number.isSafeInteger(configuredMaxAge) && configuredMaxAge > 0 ? configuredMaxAge : 120_000
  const hasIndexerError = Boolean(indexer.lastRun.error)
  const indexerReady = checkpoint !== null && lastRunAgeMs !== null && !hasIndexerError && lastRunAgeMs <= maxAgeMs && (lagLedgers === null || lagLedgers <= lagLimit)
  const ready = database.ok && rpc.ok && indexerReady
  const components = {
    database,
    sorobanRpc: rpc,
    indexer: {
      ok: indexerReady,
      indexedThrough,
      checkpointUpdatedAt: checkpoint?.updatedAt ?? null,
      latestLedger: rpc.latestLedger ?? null,
      lagLedgers,
      lagLimit,
      lastCheckpointAgeMs: lastRunAgeMs,
      maxAgeMs,
      lastRunIndexedEvents: indexer.lastRun.indexed,
      hasRecentProcessError: hasIndexerError,
    },
    media: { r2Configured: r2Enabled, cloudinaryConfigured: cloudinaryEnabled },
    network: (process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase(),
  }
  const alert = await deliverOpsAlert(ready ? 'recovered' : 'degraded', ready
    ? 'Database, Soroban RPC and indexer checks are healthy again.'
    : `Readiness degraded: database=${database.ok ? 'ok' : 'failed'}, Soroban RPC=${rpc.ok ? 'ok' : 'failed'}, indexer=${indexerReady ? 'ok' : 'failed'}; lag=${lagLedgers ?? 'unknown'} ledgers.`)
  const alertState = await query<{ last_sent_at: string; last_result: string }[]>('SELECT last_sent_at, last_result FROM ops_alert_state WHERE alert_key = ?', ['readiness'])
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checkedAt: new Date().toISOString(), components, alert: { ...alert, emailConfigured: mailConfigured() && Boolean(process.env.OPS_ALERT_EMAIL ?? 'akintoyeisaac5@gmail.com'), webhookConfigured: Boolean(process.env.OPS_ALERT_WEBHOOK_URL), lastSentAt: alertState[0]?.last_sent_at ?? null, lastResult: alertState[0]?.last_result ?? 'no_alert_sent_yet' } })
})

app.get('/api/cron/ops-monitor', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const secret = process.env.CRON_SECRET
  if (!secret || !constantTimeStringEqual(`Bearer ${secret}`, req.header('authorization') ?? '')) return res.status(401).json({ error: 'Cron authorization required' })
  try {
    await ensureSchema()
    await runIndexerOnce()
    const database = await checkDatabaseConnection()
    const rpcUrl = process.env.STELLAR_RPC_URL ?? process.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'
    let latestLedger: number | null = null
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'scheduled-ops-monitor', method: 'getLatestLedger', params: {} }), signal: AbortSignal.timeout(5000) })
      const payload = await response.json() as { result?: { sequence?: number | string }; error?: unknown }
      const ledger = Number(payload.result?.sequence)
      if (response.ok && !payload.error && Number.isSafeInteger(ledger) && ledger > 0) latestLedger = ledger
    } catch { /* represented as unavailable below */ }
    const checkpoint = await readIndexerCheckpoint()
    const lag = latestLedger !== null && checkpoint ? Math.max(0, latestLedger - checkpoint.nextLedger + 1) : null
    const lagLimit = Number(process.env.OPS_INDEXER_LAG_ALERT_LEDGERS ?? 5000)
    const maxAge = Number(process.env.OPS_INDEXER_MAX_AGE_MS ?? 120000)
    const age = checkpoint ? Math.max(0, Date.now() - Date.parse(checkpoint.updatedAt)) : null
    const healthy = database.ok && latestLedger !== null && checkpoint !== null && age !== null && age <= maxAge && (lag === null || lag <= lagLimit)
    const alert = await deliverOpsAlert(healthy ? 'recovered' : 'degraded', healthy
      ? `Scheduled check passed. Indexer is ${lag} ledgers behind.`
      : `Scheduled check failed: database=${database.ok ? 'ok' : 'failed'}, Soroban RPC=${latestLedger === null ? 'failed' : 'ok'}, checkpoint=${checkpoint ? 'present' : 'missing'}, lag=${lag ?? 'unknown'}, checkpointAgeMs=${age ?? 'unknown'}.`)
    return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'degraded', checkedAt: new Date().toISOString(), database: database.ok, latestLedger, checkpointLedger: checkpoint?.nextLedger ?? null, lagLedgers: lag, alert })
  } catch {
    await deliverOpsAlert('degraded', 'Scheduled operations monitor failed while querying readiness state.')
    return res.status(503).json({ status: 'degraded' })
  }
})

app.get('/api/cron/marketplace-maintenance', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const secret = process.env.CRON_SECRET
  if (!secret || !constantTimeStringEqual(`Bearer ${secret}`, req.header('authorization') ?? '')) {
    return res.status(401).json({ error: 'Cron authorization required' })
  }
  try {
    const result = await runMarketplaceKeeper()
    return res.json({ status: result.failed ? 'partial' : 'complete', ...result })
  } catch (error) {
    console.error('Scheduled marketplace maintenance failed', error)
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Marketplace maintenance is unavailable' })
  }
})

app.get('/api/admin/ops/reconciliation', requireAdmin, async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    await ensureSchema()
    const [summary, recent, runs] = await Promise.all([
      query<{ confirmed_mints: number; missing_owner_projection: number; missing_metadata_projection: number; latest_ledger: number | null }[]>(
        `SELECT COUNT(*)::int AS confirmed_mints,
          COUNT(*) FILTER (WHERE o.token_id IS NULL)::int AS missing_owner_projection,
          COUNT(*) FILTER (WHERE m.token_id IS NULL)::int AS missing_metadata_projection,
          MAX(v.ledger)::int AS latest_ledger
         FROM verified_nft_mints v
         LEFT JOIN nft_ownership o ON LOWER(o.contract_id)=LOWER(v.contract_id) AND o.token_id=v.token_id
         LEFT JOIN nft_mints m ON LOWER(m.contract_id)=LOWER(v.contract_id) AND m.token_id=v.token_id`,
      ),
      query<{ tx_hash: string; contract_id: string; token_id: number; ledger: number; owner_projected: boolean; metadata_projected: boolean }[]>(
        `SELECT v.tx_hash, v.contract_id, v.token_id, v.ledger,
          (o.token_id IS NOT NULL) AS owner_projected, (m.token_id IS NOT NULL) AS metadata_projected
         FROM verified_nft_mints v
         LEFT JOIN nft_ownership o ON LOWER(o.contract_id)=LOWER(v.contract_id) AND o.token_id=v.token_id
         LEFT JOIN nft_mints m ON LOWER(m.contract_id)=LOWER(v.contract_id) AND m.token_id=v.token_id
         ORDER BY v.ledger DESC, v.token_id DESC LIMIT 25`,
      ),
      query<{ checked: number; mismatches: number; repaired: number; failed: number; metadata_repaired: number; metadata_failed: number; latest_ledger: number | null; created_at: string }[]>(
        'SELECT checked, mismatches, repaired, failed, metadata_repaired, metadata_failed, latest_ledger, created_at FROM ops_reconciliation_runs ORDER BY id DESC LIMIT 10',
      ),
    ])
    res.json({ checkedAt: new Date().toISOString(), summary: summary[0] ?? { confirmed_mints: 0, missing_owner_projection: 0, missing_metadata_projection: 0, latest_ledger: null }, recentTransactions: recent, recoveryRuns: runs })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load reconciliation dashboard' })
  }
})

app.post('/api/admin/ops/reconciliation/recover', requireAdmin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    await ensureSchema()
    const limit = Number(req.body?.limit ?? 50)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ error: 'Recovery batch limit must be between 1 and 100' })
    await runIndexerOnce()
    const result = await reconcileOwnershipAgainstSoroban(limit)
    const metadataRows = await query<{ contract_id: string; token_id: number; tx_hash: string; minter: string }[]>(
      `SELECT v.contract_id, v.token_id, v.tx_hash, v.minter FROM verified_nft_mints v
       LEFT JOIN nft_mints m ON LOWER(m.contract_id)=LOWER(v.contract_id) AND m.token_id=v.token_id
       WHERE m.token_id IS NULL ORDER BY v.ledger DESC LIMIT ?`, [limit],
    )
    let metadataRepaired = 0
    let metadataFailed = 0
    for (const mint of metadataRows) {
      try {
        if (await indexConfirmedMint(mint.contract_id, mint.token_id, mint.tx_hash, mint.minter)) metadataRepaired += 1
        else metadataFailed += 1
      } catch { metadataFailed += 1 }
    }
    await query('INSERT INTO ops_reconciliation_runs (checked, mismatches, repaired, failed, metadata_repaired, metadata_failed, latest_ledger) VALUES (?, ?, ?, ?, ?, ?, ?)', [result.checked, result.mismatches, result.repaired, result.failed, metadataRepaired, metadataFailed, result.latestLedger])
    const completed = { ...result, metadataRepaired, metadataFailed, completedAt: new Date().toISOString() }
    console.log(JSON.stringify({ event: 'ownership_reconciliation_run', ...completed }))
    res.json(completed)
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Ownership reconciliation failed' })
  }
})

app.get('/api/indexer/status', requireAdmin, async (_req, res) => {
  if (isVercel) await runIndexerOnce()
  const [status, checkpoint] = await Promise.all([Promise.resolve(indexerStatus()), readIndexerCheckpoint()])
  res.json({
    network: (process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase(),
    cursor: checkpoint?.nextLedger ?? status.cursor,
    checkpointUpdatedAt: checkpoint?.updatedAt ?? null,
    lastRun: {
      startedAt: status.lastRun.startedAt,
      latestLedger: status.lastRun.latestLedger ?? null,
      indexed: status.lastRun.indexed,
      hasError: Boolean(status.lastRun.error),
    },
    trackedNftContractCount: status.nftContractIds.length,
  })
})

app.get('/api/marketplace/status', async (_req, res) => {
  if (!databaseAvailable()) return res.json({ database: false, indexed: false })
  try {
    if (isVercel) await runIndexerOnce()
    await ensureSchema()
    const marketplaceContractId = process.env.STELLAR_MARKETPLACE_CONTRACT_ID ?? process.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? ''
    const [listings, offers, collectionOffers, traitOffers, owners, auctions] = await Promise.all([
      query('SELECT * FROM marketplace_listings WHERE contract_id = ? AND active = TRUE AND expires_at > 0 ORDER BY updated_at DESC LIMIT 100', [marketplaceContractId]),
      query('SELECT * FROM marketplace_offers WHERE contract_id = ? AND active = TRUE ORDER BY updated_at DESC LIMIT 100', [marketplaceContractId]),
      query('SELECT * FROM marketplace_collection_offers WHERE contract_id = ? AND active = TRUE ORDER BY updated_at DESC LIMIT 100', [marketplaceContractId]),
      query('SELECT * FROM marketplace_trait_offers WHERE contract_id = ? AND active = TRUE ORDER BY updated_at DESC LIMIT 100', [marketplaceContractId]),
      query('SELECT * FROM nft_ownership ORDER BY updated_at DESC LIMIT 500'),
      query('SELECT * FROM marketplace_auctions WHERE contract_id = ? AND active = TRUE ORDER BY updated_at DESC LIMIT 100', [marketplaceContractId]),
    ])
    res.json({ database: true, indexed: true, listings, offers, collectionOffers, traitOffers, owners, auctions })
  } catch (error) {
    res.status(503).json({ database: true, indexed: false, error: error instanceof Error ? error.message : 'Marketplace read model unavailable' })
  }
})

app.get('/api/marketplace/ownership/:wallet', async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  const wallet = String(req.params.wallet ?? '')
  if (!stellarAddress.test(wallet)) return res.status(400).json({ error: 'Invalid Stellar wallet address' })
  try {
    await ensureSchema()
    const owned = await query<{ contract_id: string; token_id: number; owner_address: string; ledger: number }[]>(
      'SELECT contract_id, token_id, owner_address, ledger FROM nft_ownership WHERE owner_address = ? ORDER BY updated_at DESC LIMIT 100',
      [wallet],
    )
    res.json({ wallet, owned })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Ownership query failed' })
  }
})

app.get('/api/social/state', requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  const [subscriptions, likes, dislikes, comments, alerts, unread, creatorFollows, postLikes, postDislikes, reposts, bookmarks] = await Promise.all([
    query<{ collection_id: string }[]>('SELECT collection_id FROM collection_subscriptions WHERE wallet_address = ?', [wallet]),
    query<{ nft_id: string }[]>('SELECT nft_id FROM nft_likes WHERE wallet_address = ?', [wallet]),
    query<{ nft_id: string }[]>('SELECT nft_id FROM nft_dislikes WHERE wallet_address = ?', [wallet]),
    query<{ id: number; nft_id: string; wallet_address: string; body: string; parent_id: number | null; created_at: Date }[]>('SELECT id, nft_id, wallet_address, body, parent_id, created_at FROM nft_comments ORDER BY created_at ASC LIMIT 1000'),
    query<{ id: number; kind: string; title: string; body: string; action_url: string; read_at: string | null; created_at: string }[]>('SELECT id, kind, title, body, action_url, read_at, created_at FROM notifications WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 50', [wallet]),
    query<{ count: number }[]>('SELECT COUNT(*) AS count FROM notifications WHERE wallet_address = ? AND read_at IS NULL', [wallet]),
    query<{ creator_id: string }[]>('SELECT creator_id FROM creator_follows WHERE wallet_address = ?', [wallet]),
    query<{ post_id: number }[]>('SELECT post_id FROM post_likes WHERE wallet_address = ?', [wallet]),
    query<{ post_id: number }[]>('SELECT post_id FROM post_dislikes WHERE wallet_address = ?', [wallet]),
    query<{ post_id: number }[]>('SELECT post_id FROM post_reposts WHERE wallet_address = ?', [wallet]),
    query<{ nft_id: string }[]>('SELECT nft_id FROM nft_bookmarks WHERE wallet_address = ?', [wallet]),
  ])
  res.json({
    subscriptions: subscriptions.map((row) => row.collection_id),
    likes: likes.map((row) => row.nft_id),
    dislikes: dislikes.map((row) => row.nft_id),
    comments,
    notifications: alerts,
    unreadCount: Number(unread[0]?.count ?? 0),
    creatorFollows: creatorFollows.map((row) => row.creator_id),
    postLikes: postLikes.map((row) => row.post_id),
    postDislikes: postDislikes.map((row) => row.post_id),
    reposts: reposts.map((row) => row.post_id),
    bookmarks: bookmarks.map((row) => row.nft_id),
  })
})

app.get('/api/notifications', requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  try {
    const [items, unread] = await Promise.all([
      query<{ id: number; kind: string; title: string; body: string; action_url: string; read_at: string | null; created_at: string }[]>('SELECT id, kind, title, body, action_url, read_at, created_at FROM notifications WHERE wallet_address = ? ORDER BY created_at DESC LIMIT 50', [wallet]),
      query<{ count: number }[]>('SELECT COUNT(*)::int AS count FROM notifications WHERE wallet_address = ? AND read_at IS NULL', [wallet]),
    ])
    res.json({ notifications: items, unreadCount: Number(unread[0]?.count ?? 0) })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load notifications' })
  }
})

app.get('/api/push/config', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.json(browserPushConfig())
})

app.post('/api/push/subscription', processRateLimit('browser-push-subscribe', 12, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const subscription = req.body?.subscription ?? req.body
  const endpoint = typeof subscription?.endpoint === 'string' ? subscription.endpoint.trim() : ''
  const p256dh = typeof subscription?.keys?.p256dh === 'string' ? subscription.keys.p256dh : ''
  const auth = typeof subscription?.keys?.auth === 'string' ? subscription.keys.auth : ''
  try {
    const endpointUrl = new URL(endpoint)
    const host = endpointUrl.hostname.toLowerCase()
    const trustedPushHost = host === 'fcm.googleapis.com'
      || host === 'updates.push.services.mozilla.com'
      || host.endsWith('.push.services.mozilla.com')
      || host === 'notify.windows.com'
      || host.endsWith('.notify.windows.com')
    if (endpointUrl.protocol !== 'https:' || !trustedPushHost || endpoint.length > 2048 || !/^[A-Za-z0-9_-]{16,256}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,256}$/.test(auth)) {
      return res.status(400).json({ error: 'A valid browser push subscription is required' })
    }
  } catch {
    return res.status(400).json({ error: 'A valid browser push subscription is required' })
  }
  if (!browserPushConfig().enabled) return res.status(503).json({ error: 'Browser alerts are not configured yet' })
  try {
    await ensureSchema()
    await query(
      `INSERT INTO browser_push_subscriptions (endpoint, wallet_address, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET wallet_address=EXCLUDED.wallet_address, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, updated_at=now()`,
      [endpoint, wallet, p256dh, auth],
    )
    res.status(201).json({ subscribed: true })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not save browser alerts' })
  }
})

app.post('/api/push/test', processRateLimit('browser-push-test', 5, 10 * 60_000), requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  if (!browserPushConfig().enabled) return res.status(503).json({ error: 'Browser alerts are not configured on the server.' })
  try {
    await ensureSchema()
    const result = await sendBrowserPush(wallet, {
      title: 'StellaNova test alert',
      body: 'Browser alerts are reaching this device.',
      url: '/account',
    })
    if (!result.subscriptions) return res.status(409).json({ error: 'No saved browser subscription was found for this wallet. Enable alerts on this device first.' })
    if (!result.sent) return res.status(502).json({ error: 'The push service rejected the test alert. Check the server delivery log for the provider response.' })
    res.json({ sent: result.sent, failed: result.failed })
  } catch (error) {
    console.error('[browser-push] test endpoint failed', error instanceof Error ? error.message : 'Unknown error')
    res.status(503).json({ error: 'Could not send a test alert. Check the server delivery log.' })
  }
})

app.delete('/api/push/subscription', processRateLimit('browser-push-unsubscribe', 12, 10 * 60_000), requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : ''
  if (!endpoint || endpoint.length > 2048) return res.status(400).json({ error: 'A valid browser push endpoint is required' })
  try {
    await ensureSchema()
    const removed = await query(
      'DELETE FROM browser_push_subscriptions WHERE endpoint = ? AND LOWER(wallet_address) = LOWER(?) RETURNING endpoint',
      [endpoint, wallet],
    )
    res.json({ unsubscribed: true, removed: removed.length > 0 })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not disable browser alerts' })
  }
})

app.post('/api/notifications/read-all', requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  try {
    await ensureSchema()
    const updated = await query<{ id: number }[]>(
      'UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE LOWER(wallet_address) = LOWER(?) AND read_at IS NULL RETURNING id',
      [wallet],
    )
    res.json({ read: true, updated: updated.length })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not mark notifications as read' })
  }
})

app.get('/api/referrals/me', requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  try {
    await ensureSchema()
    let rows = await query<{ code: string }[]>('SELECT code FROM referral_codes WHERE LOWER(wallet_address) = LOWER(?) LIMIT 1', [wallet])
    for (let attempt = 0; !rows.length && attempt < 5; attempt += 1) {
      const code = crypto.randomBytes(8).toString('hex').toUpperCase()
      await query('INSERT INTO referral_codes (wallet_address, code) VALUES (?, ?) ON CONFLICT DO NOTHING', [wallet, code])
      rows = await query<{ code: string }[]>('SELECT code FROM referral_codes WHERE LOWER(wallet_address) = LOWER(?) LIMIT 1', [wallet])
    }
    if (!rows.length) return res.status(503).json({ error: 'Could not create your invite link. Please retry.' })
    const counts = await query<{ referrals: number; activated: number }[]>(
      'SELECT COUNT(*)::int AS referrals, COUNT(*) FILTER (WHERE activated_at IS NOT NULL)::int AS activated FROM referrals WHERE LOWER(referrer_wallet) = LOWER(?)',
      [wallet],
    )
    res.json({ code: rows[0].code, referrals: Number(counts[0]?.referrals ?? 0), activated: Number(counts[0]?.activated ?? 0) })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load referral summary' })
  }
})

// Register a token → collection mapping so the indexer can attribute mints to a
// collection and fan out “new drop” notifications to its subscribers.
app.post('/api/collections/:collectionId/tokens/:tokenId', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const collectionId = slug(String(req.params.collectionId))
  const tokenId = String(req.params.tokenId).replace(/[^0-9]+/g, '')
  if (!collectionId || !tokenId) return res.status(400).json({ error: 'collectionId and tokenId are required' })
  const collection = await collectionBySlug(collectionId)
  if (!collection?.contract_id) return res.status(404).json({ error: 'Collection contract not found' })
  const contractId = collection.contract_id
  // Only wallets that own the token may register it into a collection.
  const owned = await query<{ owner_address: string }[]>(
    'SELECT owner_address FROM nft_ownership WHERE contract_id = ? AND token_id = ? LIMIT 1',
    [contractId, tokenId],
  )
  if (!owned.length) return res.status(409).json({ error: 'Token ownership has not been indexed yet' })
  if (owned[0].owner_address !== wallet) return res.status(403).json({ error: 'Only the token owner can register it' })
  await query(
    'INSERT INTO token_collections (contract_id, token_id, collection_id) VALUES (?, ?, ?) ON CONFLICT (contract_id, token_id) DO UPDATE SET collection_id=EXCLUDED.collection_id',
    [contractId, tokenId, collectionId],
  )
  res.status(201).json({ registered: true, collectionId, tokenId })
})

app.get('/api/collections/registry', requireWallet, async (_req, res) => {
  const rows = await query<{ contract_id: string; token_id: number; collection_id: string }[]>(
    'SELECT contract_id, token_id, collection_id FROM token_collections ORDER BY created_at DESC LIMIT 500',
  )
  res.json({ registry: rows })
})

// ---- Mint a new NFT (read-model + metadata persistence) ----
// The on-chain `mint` transaction itself is signed and submitted by the client
// wallet (non-custodial). This endpoint records the freshly minted token in the
// read model and maps it into a collection so it can be surfaced in the feed and
// become listable/tradeable. Ownership itself is tracked by the indexer from the
// on-chain mint event.
app.post('/api/nfts/mint', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const tokenId = Number(req.body?.tokenId)
  const collectionId = slug(String(req.body?.collectionId ?? ''))
  const personalScope = `personal-${wallet.toLowerCase()}`
  const isPersonalMint = collectionId === personalScope && req.body?.stageId == null
  const submittedContractId = String(req.body?.contractId ?? '').trim()
  const title = String(req.body?.title ?? '').trim().slice(0, 160)
  const submittedMetadataUri = String(req.body?.metadataUri ?? '').trim().slice(0, 1024)
  const stageId = req.body?.stageId === undefined || req.body?.stageId === null || req.body?.stageId === '' ? null : Number(req.body.stageId)
  const submittedTxHash = String(req.body?.txHash ?? '').trim().slice(0, 64)
  const priceRaw = req.body?.price
  if (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId > 0xffff_ffff) return res.status(400).json({ error: 'A valid tokenId is required' })
  if (!collectionId) return res.status(400).json({ error: 'A mint scope is required' })
  if (stageId === null && (!submittedMetadataUri || !/^https:\/\//i.test(submittedMetadataUri))) return res.status(400).json({ error: 'A public metadata URI is required' })
  if (submittedTxHash && !/^[a-f0-9]{64}$/i.test(submittedTxHash)) return res.status(400).json({ error: 'Transaction hash must be 64 hexadecimal characters' })
  if (stageId !== null && (!Number.isSafeInteger(stageId) || stageId < 0 || stageId > 0xffff_ffff)) return res.status(400).json({ error: 'Invalid mint stage' })
  const priceXlm = priceRaw === undefined || priceRaw === null || priceRaw === '' ? null : Number(priceRaw)
  if (priceXlm !== null && (!Number.isFinite(priceXlm) || priceXlm < 0)) return res.status(400).json({ error: 'Invalid price in XLM' })
  try {
    await ensureSchema()
    const collection = isPersonalMint ? null : await collectionBySlug(collectionId)
    if (!isPersonalMint && !collection) return res.status(404).json({ error: 'Collection not found' })
    if (!isPersonalMint && !collection?.contract_id) return res.status(409).json({ error: 'This collection has no registered NFT contract' })
    const contractId = isPersonalMint ? submittedContractId : collection!.contract_id!
    if (!/^C[A-Z2-7]{55}$/.test(contractId)) return res.status(400).json({ error: 'A valid NFT contract is required' })
    let verifiedMint = await query<{ minter: string; tx_hash: string }[]>(
      'SELECT minter, tx_hash FROM verified_nft_mints WHERE contract_id = ? AND token_id = ? LIMIT 1',
      [contractId, tokenId],
    )
    // Don't make a just-confirmed mint wait for the indexer's 15-second timer.
    // Process the latest ledger now, then keep the normal 409 retry as a fallback
    // if the RPC event endpoint has not exposed the mint event yet.
    if (!verifiedMint.length) {
      await runIndexerOnce()
      verifiedMint = await query(
        'SELECT minter, tx_hash FROM verified_nft_mints WHERE contract_id = ? AND token_id = ? LIMIT 1',
        [contractId, tokenId],
      )
    }
    // A serverless or continuously running indexer can advance its checkpoint
    // before Stellar RPC exposes a newly confirmed event. Recover this exact
    // mint by its transaction hash so it does not remain device-local pending.
    if (!verifiedMint.length && submittedTxHash) {
      try { await indexConfirmedMint(contractId, tokenId, submittedTxHash, wallet) }
      catch (error) { console.error('Confirmed mint event recovery failed:', error) }
      verifiedMint = await query(
        'SELECT minter, tx_hash FROM verified_nft_mints WHERE contract_id = ? AND token_id = ? LIMIT 1',
        [contractId, tokenId],
      )
    }
    if (!verifiedMint.length) return res.status(409).json({ error: 'The mint event is not indexed yet; retry shortly' })
    if (verifiedMint[0].minter !== wallet) return res.status(403).json({ error: 'Only the wallet that minted this token may register its metadata' })
    // Older clients dropped the successful submission hash while polling
    // getTransaction. Recover it from the already verified on-chain mint event
    // so the pending mint can finish indexing without asking the wallet to mint
    // a second token.
    const txHash = submittedTxHash || verifiedMint[0].tx_hash
    if (verifiedMint[0].tx_hash !== txHash) return res.status(403).json({ error: 'The transaction does not match the indexed mint' })
    let metadataUri = submittedMetadataUri
    let metadata: { metadata_uri: string; object_key: string; sha256: string; bytes: number; name: string; image: string; animation_url: string | null; description: string; attributes: unknown }[]
    if (stageId === null) {
      if (!isPersonalMint && collection!.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection creator can register a direct mint' })
      metadata = await query('SELECT metadata_uri, object_key, sha256, bytes, name, image, animation_url, description, attributes FROM creator_nft_metadata WHERE metadata_uri = ? AND collection_id = ? AND creator_wallet = ? LIMIT 1', [metadataUri, collectionId, wallet])
    } else {
      const stage = await query<{ metadata_uris: string[] }[]>('SELECT metadata_uris FROM mint_stages WHERE id = ? AND collection_id = ?', [stageId, collectionId])
      if (!stage.length) return res.status(403).json({ error: 'Mint stage does not belong to this collection' })
      const stageEvent = await query<{ tx_hash: string; token_ids: number[]; edition_start: number }[]>(
        'SELECT tx_hash, token_ids, edition_start FROM stage_mint_events WHERE contract_id = ? AND tx_hash = ? AND stage_id = ? AND wallet = ? AND token_ids @> ARRAY[?]::int[] LIMIT 1',
        [contractId, txHash, stageId, wallet, tokenId],
      )
      if (!stageEvent.length) return res.status(409).json({ error: 'The stage mint event is not indexed yet; retry shortly' })
      const tokenPosition = stageEvent[0].token_ids.indexOf(tokenId)
      const editionIndex = Number(stageEvent[0].edition_start) + tokenPosition
      const editionUris = stage[0].metadata_uris ?? []
      const expectedUri = editionUris.length ? editionUris[editionIndex % editionUris.length] : undefined
      if (!expectedUri || (metadataUri && expectedUri !== metadataUri)) return res.status(403).json({ error: 'Edition metadata does not match this minted token' })
      metadataUri = expectedUri
      metadata = await query('SELECT metadata_uri, object_key, sha256, bytes, name, image, animation_url, description, attributes FROM creator_nft_metadata WHERE metadata_uri = ? AND collection_id = ? LIMIT 1', [metadataUri, collectionId])
    }
    if (!metadata.length) return res.status(400).json({ error: 'Metadata URI is not registered to this collection' })
    const canonical = metadata[0]
    await query(
      `INSERT INTO nft_mints (contract_id, token_id, minter, collection_id, title, image, animation_url, price_xlm, metadata_uri, stage_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (contract_id, token_id) DO UPDATE SET
         collection_id=EXCLUDED.collection_id, title=EXCLUDED.title, image=EXCLUDED.image,
         animation_url=EXCLUDED.animation_url, price_xlm=EXCLUDED.price_xlm, metadata_uri=EXCLUDED.metadata_uri, stage_id=EXCLUDED.stage_id
       WHERE nft_mints.minter = EXCLUDED.minter`,
      [contractId, tokenId, wallet, isPersonalMint ? null : collectionId, canonical.name, canonical.image, canonical.animation_url, priceXlm, canonical.metadata_uri, stageId],
    )
    await query(
      `INSERT INTO canonical_metadata (token_id, contract_id, object_key, metadata_uri, sha256, content_type, bytes)
       SELECT ?, ?, object_key, metadata_uri, sha256, 'application/json', bytes
       FROM creator_nft_metadata WHERE metadata_uri = ?
       ON CONFLICT (contract_id, token_id) DO UPDATE SET object_key=EXCLUDED.object_key, metadata_uri=EXCLUDED.metadata_uri, sha256=EXCLUDED.sha256, content_type=EXCLUDED.content_type, bytes=EXCLUDED.bytes`,
      [tokenId, contractId, metadataUri],
    )
    if (!isPersonalMint) {
      await query(
        'INSERT INTO token_collections (contract_id, token_id, collection_id) VALUES (?, ?, ?) ON CONFLICT (contract_id, token_id) DO UPDATE SET collection_id=EXCLUDED.collection_id',
        [contractId, tokenId, collectionId],
      )
    }
    res.status(201).json({ minted: true, contractId, tokenId, collectionId: isPersonalMint ? null : collectionId, title: canonical.name, metadataUri: canonical.metadata_uri })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not record minted NFT' })
  }
})

// Private portfolio read: collection mints stay visible to their current owner
// before reveal, while the public minted feed continues to hide unrevealed work.
app.get('/api/nfts/minted/owned', requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  try {
    await ensureSchema()
    const minted = await query<{ contract_id: string; token_id: number; minter: string; owner_address: string | null; owner_name: string | null; collection_id: string | null; title: string; image: string; animation_url: string | null; price_xlm: string | null; metadata_uri: string; created_at: string; attributes: { trait_type: string; value: string | number | boolean }[] }[]>(
      `SELECT m.contract_id, m.token_id, m.minter,
              o.owner_address AS owner_address,
              CASE WHEN NULLIF(p.creator_username, '') IS NOT NULL THEN '@' || p.creator_username ELSE NULLIF(p.display_name, '') END AS owner_name,
              m.collection_id,
              CASE WHEN c.revealed THEN m.title ELSE COALESCE(c.name, 'Unrevealed collection NFT') END AS title,
              CASE WHEN c.revealed THEN m.image ELSE COALESCE(c.cover, '') END AS image,
              CASE WHEN c.revealed THEN m.animation_url ELSE NULL END AS animation_url,
              m.price_xlm, m.metadata_uri, m.created_at,
              CASE WHEN c.revealed AND jsonb_typeof(meta.attributes) = 'array' THEN meta.attributes ELSE '[]'::jsonb END AS attributes
       FROM nft_mints m
       INNER JOIN verified_nft_mints v ON v.contract_id = m.contract_id AND v.token_id = m.token_id
       LEFT JOIN nft_ownership o ON LOWER(o.contract_id) = LOWER(m.contract_id) AND o.token_id = m.token_id
       LEFT JOIN user_profiles p ON LOWER(p.wallet_address) = LOWER(o.owner_address)
       LEFT JOIN collections c ON c.slug = m.collection_id
       LEFT JOIN creator_nft_metadata meta ON meta.metadata_uri = m.metadata_uri
       WHERE LOWER(o.owner_address) = LOWER(?)
       ORDER BY m.created_at DESC LIMIT 500`,
      [wallet],
    )
    res.json({ minted })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Owned mint query failed' })
  }
})

app.get('/api/nfts/minted', async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  try {
    await ensureSchema()
    const rows = await query<{ contract_id: string; token_id: number; minter: string; owner_address: string | null; owner_name: string | null; collection_id: string | null; title: string; image: string; animation_url: string | null; price_xlm: string | null; metadata_uri: string; created_at: string; attributes: { trait_type: string; value: string | number | boolean }[]; rarity_rank: number; rarity_score: string }[]>(
      `WITH visible_mints AS (
         SELECT m.contract_id, m.token_id, m.minter, m.collection_id, m.title, m.image, m.animation_url, m.price_xlm, m.metadata_uri, m.created_at,
                CASE WHEN jsonb_typeof(meta.attributes) = 'array' THEN meta.attributes ELSE '[]'::jsonb END AS attributes
         FROM nft_mints m
         INNER JOIN verified_nft_mints v ON v.contract_id = m.contract_id AND v.token_id = m.token_id
         LEFT JOIN collections c ON c.slug = m.collection_id
         LEFT JOIN creator_nft_metadata meta ON meta.metadata_uri = m.metadata_uri
         WHERE m.image NOT ILIKE '%unsplash.com%' AND (m.collection_id IS NULL OR c.revealed = TRUE)
       ), trait_values AS (
         SELECT vm.contract_id, vm.collection_id, vm.token_id, attribute->>'trait_type' AS trait_type, attribute->>'value' AS trait_value
         FROM visible_mints vm CROSS JOIN LATERAL jsonb_array_elements(vm.attributes) AS attrs(attribute)
         WHERE NULLIF(trim(attribute->>'trait_type'), '') IS NOT NULL AND jsonb_exists(attribute, 'value') AND attribute->'value' <> 'null'::jsonb
       ), trait_frequencies AS (
         SELECT contract_id, collection_id, trait_type, trait_value, COUNT(*)::numeric AS frequency
         FROM trait_values GROUP BY contract_id, collection_id, trait_type, trait_value
       ), token_scores AS (
         SELECT tv.contract_id, tv.collection_id, tv.token_id, SUM(1::numeric / tf.frequency) AS rarity_score
         FROM trait_values tv
         INNER JOIN trait_frequencies tf USING (contract_id, collection_id, trait_type, trait_value)
         GROUP BY tv.contract_id, tv.collection_id, tv.token_id
       ), ranked_mints AS (
         SELECT vm.*, COALESCE(ts.rarity_score, 0::numeric) AS rarity_score,
                (RANK() OVER (PARTITION BY vm.contract_id, vm.collection_id ORDER BY COALESCE(ts.rarity_score, 0::numeric) DESC))::int AS rarity_rank
         FROM visible_mints vm LEFT JOIN token_scores ts USING (contract_id, collection_id, token_id)
       )
       SELECT m.contract_id, m.token_id, m.minter, o.owner_address AS owner_address, CASE WHEN NULLIF(p.creator_username, '') IS NOT NULL THEN '@' || p.creator_username ELSE NULLIF(p.display_name, '') END AS owner_name, m.collection_id, m.title, m.image, m.animation_url, m.price_xlm, m.metadata_uri, m.created_at, m.attributes, m.rarity_rank, m.rarity_score
       FROM ranked_mints m LEFT JOIN nft_ownership o ON LOWER(o.contract_id) = LOWER(m.contract_id) AND o.token_id = m.token_id LEFT JOIN user_profiles p ON LOWER(p.wallet_address) = LOWER(o.owner_address) ORDER BY m.created_at DESC LIMIT 300`,
    )
    res.json({ minted: rows })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Minted query failed' })
  }
})

// Public NFT activity is built only from confirmed contract events indexed by
// Soroban. Social reactions and off-chain marketplace records are deliberately
// excluded from this timeline.
app.get('/api/nfts/:contract/:tokenId/activity', async (req, res) => {
  const contractId = String(req.params.contract ?? '').toUpperCase()
  const tokenId = Number(req.params.tokenId)
  if (!/^C[A-Z2-7]{55}$/.test(contractId) || !Number.isSafeInteger(tokenId) || tokenId < 0) {
    return res.status(400).json({ error: 'A valid NFT contract and token ID are required' })
  }
  if (!databaseAvailable()) return res.status(503).json({ error: 'Confirmed NFT activity is not available' })
  try {
    await ensureSchema()
    const [mintRows, eventRows] = await Promise.all([
      query<{ minter: string; tx_hash: string; ledger: number }[]>(
        'SELECT minter, tx_hash, ledger FROM verified_nft_mints WHERE LOWER(contract_id) = LOWER(?) AND token_id = ? LIMIT 1',
        [contractId, tokenId],
      ),
      query<{ event_type: string; tx_hash: string; ledger: number; payload: { topics?: unknown; value?: unknown } }[]>(
        `SELECT event_type, tx_hash, ledger, payload FROM marketplace_events
         WHERE (LOWER(contract_id) = LOWER(?) AND event_type IN ('transfer', 'mint')
                AND COALESCE(payload->'value'->>0, payload->'value' #>> '{}', '') = ?)
            OR (event_type IN ('sale', 'offer_s', 'offer_sale', 'auc_s', 'auction_sale')
                AND LOWER(COALESCE(payload->'value'->>3, '')) = LOWER(?)
                AND COALESCE(payload->'value'->>4, '') = ?)
         ORDER BY ledger ASC LIMIT 1000`,
        [contractId, String(tokenId), contractId, String(tokenId)],
      ),
    ])
    const activity: { kind: 'mint' | 'transfer' | 'sale'; tx_hash: string; ledger: number; from: string | null; to: string | null; amount_xlm: string | null }[] = []
    const mint = mintRows[0]
    if (mint) activity.push({ kind: 'mint', tx_hash: mint.tx_hash, ledger: mint.ledger, from: null, to: mint.minter, amount_xlm: null })
    const eventData = (value: unknown): unknown[] => {
      if (Array.isArray(value)) return value
      if (value && typeof value === 'object' && Array.isArray((value as { values?: unknown }).values)) return (value as { values: unknown[] }).values
      return [value]
    }
    const stringValue = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : String(value)
    const toXlm = (value: unknown): string | null => {
      try {
        const stroops = BigInt(stringValue(value))
        const whole = stroops / 10_000_000n
        const fraction = (stroops % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
        return fraction ? `${whole}.${fraction}` : String(whole)
      } catch { return null }
    }
    const saleTxs = new Set(eventRows.filter((event) => ['sale', 'offer_s', 'offer_sale', 'auc_s', 'auction_sale'].includes(event.event_type)).map((event) => event.tx_hash))
    for (const event of eventRows) {
      const values = eventData(event.payload?.value)
      const topics = Array.isArray(event.payload?.topics) ? event.payload!.topics as unknown[] : []
      if (['sale', 'offer_s', 'offer_sale', 'auc_s', 'auction_sale'].includes(event.event_type)) {
        const nftContractIndex = 3
        const tokenIndex = 4
        if (stringValue(values[nftContractIndex]).toLowerCase() !== contractId.toLowerCase() || Number(values[tokenIndex]) !== tokenId) continue
        activity.push({ kind: 'sale', tx_hash: event.tx_hash, ledger: event.ledger, from: stringValue(values[2]) || null, to: stringValue(values[1]) || null, amount_xlm: toXlm(values[5]) })
        continue
      }
      if (event.event_type === 'mint') continue // represented by verified_nft_mints above
      const tokenValue = Number(values[0])
      if (event.event_type !== 'transfer' || tokenValue !== tokenId || saleTxs.has(event.tx_hash)) continue
      activity.push({ kind: 'transfer', tx_hash: event.tx_hash, ledger: event.ledger, from: stringValue(topics[1]) || null, to: stringValue(topics[2]) || null, amount_xlm: null })
    }
    const unique = new Map<string, typeof activity[number]>()
    for (const item of activity) unique.set(`${item.tx_hash}:${item.kind}`, item)
    res.json({ activity: [...unique.values()].sort((a, b) => b.ledger - a.ledger) })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'NFT activity query failed' })
  }
})

// Provenance combines creator metadata and upload fingerprints with the
// independently indexed Stellar mint transaction. It never treats a wallet
// address or a submitted file hash as proof of copyright.
app.get('/api/nfts/:contract/:tokenId/provenance', async (req, res) => {
  const contractId = String(req.params.contract ?? '').toUpperCase()
  const tokenId = Number(req.params.tokenId)
  if (!/^C[A-Z2-7]{55}$/.test(contractId) || !Number.isSafeInteger(tokenId) || tokenId < 0) {
    return res.status(400).json({ error: 'A valid NFT contract and token ID are required' })
  }
  if (!databaseAvailable()) return res.status(503).json({ error: 'NFT provenance is not available' })
  try {
    await ensureSchema()
    const rows = await query<{
      minter: string; tx_hash: string; ledger: number;
      metadata_uri: string | null; metadata_sha256: string | null; metadata_created_at: string | null;
      asset_sha256: string | null; asset_content_type: string | null; asset_bytes: number | null;
      asset_sha256_verified: boolean | null;
      animation_sha256: string | null; animation_content_type: string | null; animation_bytes: number | null;
      animation_sha256_verified: boolean | null;
      provenance: Record<string, unknown> | null
    }[]>(
      `SELECT verified.minter, verified.tx_hash, verified.ledger,
              meta.metadata_uri, meta.sha256 AS metadata_sha256, meta.created_at AS metadata_created_at,
              asset.sha256 AS asset_sha256, asset.content_type AS asset_content_type, asset.bytes AS asset_bytes,
              asset.sha256_verified AS asset_sha256_verified,
              animation.sha256 AS animation_sha256, animation.content_type AS animation_content_type, animation.bytes AS animation_bytes,
              animation.sha256_verified AS animation_sha256_verified,
              meta.provenance
       FROM verified_nft_mints verified
       LEFT JOIN nft_mints minted ON LOWER(minted.contract_id) = LOWER(verified.contract_id) AND minted.token_id = verified.token_id
       LEFT JOIN creator_nft_metadata meta ON meta.metadata_uri = minted.metadata_uri
       LEFT JOIN creator_media_uploads asset ON asset.image_url = meta.image
       LEFT JOIN creator_media_uploads animation ON animation.image_url = meta.animation_url
       WHERE LOWER(verified.contract_id) = LOWER(?) AND verified.token_id = ? LIMIT 1`,
      [contractId, tokenId],
    )
    const row = rows[0]
    if (!row) return res.status(404).json({ error: 'No confirmed mint record was found for this NFT' })
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
    res.json({
      contract_id: contractId,
      token_id: tokenId,
      creator_wallet: row.provenance?.version === 1 && typeof row.provenance.creator_wallet === 'string' ? row.provenance.creator_wallet : null,
      minter: row.minter,
      mint_tx_hash: row.tx_hash,
      mint_ledger: row.ledger,
      metadata_uri: row.metadata_uri,
      metadata_sha256: row.metadata_sha256,
      metadata_created_at: row.metadata_created_at,
      asset_sha256: row.asset_sha256,
      asset_content_type: row.asset_content_type,
      asset_bytes: row.asset_bytes,
      asset_sha256_verified: Boolean(row.asset_sha256_verified),
      animation_sha256: row.animation_sha256,
      animation_content_type: row.animation_content_type,
      animation_bytes: row.animation_bytes,
      animation_sha256_verified: Boolean(row.animation_sha256_verified),
      version: Number(row.provenance?.version ?? 0),
      creation_method: typeof row.provenance?.creation_method === 'string' ? row.provenance.creation_method : null,
    })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'NFT provenance query failed' })
  }
})

// Public, shareable marketplace snapshot. Every value comes from confirmed
// indexer/read-model records; keep projections separate to avoid join inflation.
app.post('/api/analytics/social-event', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.status(410).json({ error: 'Client-submitted social analytics are disabled. Product engagement must be derived from verified StellaNova records.' })
})

app.get('/api/analytics/overview', async (_req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Analytics data is not configured' })
  try {
    if (isVercel) await runIndexerOnce()
    await ensureSchema()
    const [summary, daily, topCollections] = await Promise.all([
      query<{ collections: number; minted: number; holders: number; listings: number; sales: number; primary_volume_xlm: string; secondary_volume_xlm: string; volume_xlm: string }[]>(
        `WITH sale_events AS (
           SELECT DISTINCT ON (tx_hash, contract_id, payload->'value'->>4)
                  tx_hash, contract_id, event_type,
                  CASE WHEN payload->'value'->>5 ~ '^[0-9]+$' THEN (payload->'value'->>5)::numeric / 10000000 ELSE 0 END AS amount_xlm
           FROM marketplace_events
           WHERE event_type IN ('sale', 'offer_s', 'offer_sale', 'auc_s', 'auction_sale')
           ORDER BY tx_hash, contract_id, payload->'value'->>4,
                    CASE event_type WHEN 'sale' THEN 0 WHEN 'offer_s' THEN 1 WHEN 'auc_s' THEN 2 ELSE 3 END
         ), mint_volume AS (
           SELECT COALESCE(SUM(paid_stroops), 0)::numeric / 10000000 AS amount_xlm
           FROM stage_mint_events WHERE paid_stroops IS NOT NULL
         ), trade_volume AS (
           SELECT COALESCE(SUM(amount_xlm), 0) AS amount_xlm, COUNT(*)::int AS sales FROM sale_events
         )
         SELECT
           (SELECT COUNT(*)::int FROM collections WHERE contract_id IS NOT NULL) AS collections,
           (SELECT COUNT(*)::int FROM verified_nft_mints) AS minted,
           (SELECT COUNT(DISTINCT owner_address)::int FROM nft_ownership WHERE owner_address LIKE 'G%') AS holders,
           (SELECT COUNT(*)::int FROM marketplace_listings WHERE active = TRUE) AS listings,
           (SELECT sales FROM trade_volume) AS sales,
           (SELECT amount_xlm FROM mint_volume)::numeric(24,2)::text AS primary_volume_xlm,
           (SELECT amount_xlm FROM trade_volume)::numeric(24,2)::text AS secondary_volume_xlm,
           ((SELECT amount_xlm FROM mint_volume) + (SELECT amount_xlm FROM trade_volume))::numeric(24,2)::text AS volume_xlm`,
      ),
      query<{ day: string; mints: number; volume_xlm: string; primary_volume_xlm: string; secondary_volume_xlm: string }[]>(
        `WITH days AS (
           SELECT generate_series(current_date - interval '29 days', current_date, interval '1 day')::date AS day
         ), mint_days AS (
           SELECT created_at::date AS day, COUNT(*)::int AS mints FROM verified_nft_mints
           WHERE created_at >= current_date - interval '29 days' GROUP BY created_at::date
         ), sale_events AS (
           SELECT DISTINCT ON (tx_hash, contract_id, payload->'value'->>4)
                  created_at::date AS day, tx_hash, contract_id,
                  CASE WHEN payload->'value'->>5 ~ '^[0-9]+$' THEN (payload->'value'->>5)::numeric / 10000000 ELSE 0 END AS amount_xlm
           FROM marketplace_events
           WHERE event_type IN ('sale', 'offer_s', 'offer_sale', 'auc_s', 'auction_sale')
             AND created_at >= current_date - interval '29 days'
           ORDER BY tx_hash, contract_id, payload->'value'->>4,
                    CASE event_type WHEN 'sale' THEN 0 WHEN 'offer_s' THEN 1 WHEN 'auc_s' THEN 2 ELSE 3 END
         ), sale_days AS (
           SELECT day, SUM(amount_xlm) AS volume_xlm FROM sale_events GROUP BY day
         ), mint_days_volume AS (
           SELECT e.created_at::date AS day, SUM(sm.paid_stroops)::numeric / 10000000 AS volume_xlm
           FROM stage_mint_events sm
           INNER JOIN marketplace_events e
             ON e.contract_id = sm.contract_id AND e.tx_hash = sm.tx_hash
             AND e.event_type = 'stage_mint'
             AND e.payload->'topics'->>1 = sm.stage_id::text
           WHERE sm.paid_stroops IS NOT NULL AND e.created_at >= current_date - interval '29 days'
           GROUP BY e.created_at::date
         )
         SELECT to_char(days.day, 'YYYY-MM-DD') AS day, COALESCE(mint_days.mints, 0)::int AS mints,
                COALESCE(mint_days_volume.volume_xlm, 0)::numeric(24,2)::text AS primary_volume_xlm,
                COALESCE(sale_days.volume_xlm, 0)::numeric(24,2)::text AS secondary_volume_xlm,
                (COALESCE(mint_days_volume.volume_xlm, 0) + COALESCE(sale_days.volume_xlm, 0))::numeric(24,2)::text AS volume_xlm
         FROM days LEFT JOIN mint_days USING (day)
         LEFT JOIN sale_days USING (day) LEFT JOIN mint_days_volume USING (day) ORDER BY days.day`,
      ),
      query<{ collection_id: string; name: string; cover: string; minted: number }[]>(
        `SELECT c.slug AS collection_id, c.name, c.cover, COUNT(v.token_id)::int AS minted
         FROM collections c
         LEFT JOIN nft_mints m ON m.collection_id = c.slug
         LEFT JOIN verified_nft_mints v ON LOWER(v.contract_id) = LOWER(m.contract_id) AND v.token_id = m.token_id
         WHERE c.contract_id IS NOT NULL
         GROUP BY c.slug, c.name, c.cover ORDER BY minted DESC, c.name ASC LIMIT 5`,
      ),
    ])
    res.json({ generatedAt: new Date().toISOString(), network: 'Stellar Testnet', summary: summary[0] ?? { collections: 0, minted: 0, holders: 0, listings: 0, sales: 0, primary_volume_xlm: '0', secondary_volume_xlm: '0', volume_xlm: '0' }, daily, topCollections })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Analytics are temporarily unavailable' })
  }
})

// Per-wallet marketplace state so owners/sellers/buyers can manage their live
// listings and offers (cancel a listing, cancel an offer, accept an incoming
// offer on a token they own). This is what powers the secondary-trading UI.
function xlmToStroops(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!/^\d{1,12}(?:\.\d{1,7})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  const amount = BigInt(whole) * 10_000_000n + BigInt((fraction + '0000000').slice(0, 7))
  return amount > 0n ? amount.toString() : null
}

app.post('/api/marketplace/offers/:offerId/counter', requireWallet, async (req, res) => {
  const seller = res.locals.wallet as string
  const offerId = Number(req.params.offerId)
  const counterAmount = xlmToStroops(req.body?.amount)
  if (!Number.isSafeInteger(offerId) || offerId < 0) return res.status(400).json({ error: 'Invalid offer ID' })
  if (!counterAmount) return res.status(400).json({ error: 'Enter a counter amount greater than 0, with up to 7 decimal places' })
  await ensureSchema()
  const marketplaceContractId = String(req.body?.contractId ?? process.env.STELLAR_MARKETPLACE_CONTRACT_ID ?? process.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? '')
  if (marketplaceContractId !== (process.env.STELLAR_MARKETPLACE_CONTRACT_ID ?? process.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? '')) return res.status(400).json({ error: 'Marketplace contract is not configured' })
  const offers = await query<{ buyer: string; nft_contract: string; token_id: number; active: boolean }[]>('SELECT buyer, nft_contract, token_id, active FROM marketplace_offers WHERE contract_id = ? AND offer_id = ?', [marketplaceContractId, offerId])
  if (!offers.length || !offers[0].active) return res.status(404).json({ error: 'This offer is no longer active' })
  const offer = offers[0]
  const owner = await query<{ owner_address: string }[]>('SELECT owner_address FROM nft_ownership WHERE contract_id = ? AND token_id = ?', [offer.nft_contract, offer.token_id])
  if (!owner.length || owner[0].owner_address.toLowerCase() !== seller.toLowerCase()) return res.status(403).json({ error: 'Only the current NFT owner can counter this offer' })
  const prior = await query<{ status: string }[]>('SELECT status FROM marketplace_offer_responses WHERE contract_id = ? AND offer_id = ?', [marketplaceContractId, offerId])
  if (prior[0]?.status === 'counter_accepted') return res.status(409).json({ error: 'This offer has already been closed' })
  const amountXlm = `${counterAmount.slice(0, -7) || '0'}.${counterAmount.slice(-7)}`.replace(/0+$/, '').replace(/\.$/, '')
  await query(`INSERT INTO marketplace_offer_responses (offer_id, contract_id, seller, buyer, status, counter_amount)
    VALUES (?, ?, ?, ?, 'countered', ?) ON CONFLICT (contract_id, offer_id) DO UPDATE SET seller=EXCLUDED.seller, buyer=EXCLUDED.buyer, status='countered', counter_amount=EXCLUDED.counter_amount, updated_at=now()`, [offerId, marketplaceContractId, seller, offer.buyer, counterAmount])
  const nft = await marketplaceNftEmailContext(offer.nft_contract, offer.token_id)
  const note = `The seller countered your offer on “${nft.title}” at ${amountXlm} XLM. Accepting submits a replacement offer; the seller still needs to accept it.\n\nToken #${offer.token_id}`
  await notifyOfferWallet(offer.buyer, 'offer_counter', 'You received a counter-offer', note, `Counter-offer · ${nft.title}`, nft.url)
  res.json({ status: 'countered', counterAmount })
})

app.post('/api/marketplace/offers/:offerId/counter-response', requireWallet, async (req, res) => {
  const buyer = res.locals.wallet as string
  const offerId = Number(req.params.offerId)
  const action = String(req.body?.action ?? '')
  if (!Number.isSafeInteger(offerId) || offerId < 0) return res.status(400).json({ error: 'Invalid offer ID' })
  if (action !== 'accept' && action !== 'reject') return res.status(400).json({ error: 'Choose accept or reject' })
  await ensureSchema()
  const marketplaceContractId = String(req.body?.contractId ?? process.env.STELLAR_MARKETPLACE_CONTRACT_ID ?? process.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? '')
  if (marketplaceContractId !== (process.env.STELLAR_MARKETPLACE_CONTRACT_ID ?? process.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? '')) return res.status(400).json({ error: 'Marketplace contract is not configured' })
  const rows = await query<{ seller: string; buyer: string; status: string; counter_amount: string | null; token_id: number; nft_contract: string }[]>(
    `SELECT r.seller, r.buyer, r.status, r.counter_amount, o.token_id, o.nft_contract FROM marketplace_offer_responses r JOIN marketplace_offers o ON o.contract_id = r.contract_id AND o.offer_id = r.offer_id WHERE o.contract_id = ? AND r.offer_id = ?`, [marketplaceContractId, offerId],
  )
  if (!rows.length || rows[0].buyer.toLowerCase() !== buyer.toLowerCase()) return res.status(404).json({ error: 'Counter-offer not found for this wallet' })
  if (rows[0].status !== 'countered') return res.status(409).json({ error: 'This counter-offer is no longer open' })
  const nft = await marketplaceNftEmailContext(rows[0].nft_contract, rows[0].token_id)
  if (action === 'accept') {
    const note = `The buyer accepted your counter for “${nft.title}” and is submitting a replacement offer. You will need to accept that on-chain offer to complete the sale.\n\nToken #${rows[0].token_id}`
    await query("UPDATE marketplace_offer_responses SET status = 'counter_accepted', updated_at = now() WHERE contract_id = ? AND offer_id = ?", [marketplaceContractId, offerId])
    await notifyOfferWallet(rows[0].seller, 'counter_accepted', 'Your counter-offer was accepted', note, `Counter accepted · ${nft.title}`, nft.url)
  } else {
    await query("UPDATE marketplace_offer_responses SET status = 'counter_rejected', updated_at = now() WHERE contract_id = ? AND offer_id = ?", [marketplaceContractId, offerId])
    await notifyOfferWallet(rows[0].seller, 'counter_rejected', 'Your counter-offer was declined', `The buyer declined your counter for “${nft.title}”.\n\nToken #${rows[0].token_id}`, `Counter declined · ${nft.title}`, nft.url)
  }
  res.json({ status: action === 'accept' ? 'counter_accepted' : 'counter_rejected', seller: rows[0].seller, counterAmount: rows[0].counter_amount })
})

app.get('/api/marketplace/state/:wallet', async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  const wallet = String(req.params.wallet ?? '')
  if (!stellarAddress.test(wallet)) return res.status(400).json({ error: 'Invalid Stellar wallet address' })
  try {
    await ensureSchema()
    // Vercel functions are stateless and do not keep the background indexer
    // alive. Let an active wallet refresh advance it so new offers reach the
    // recipient's account without relying on an unrelated status page visit.
    if (isVercel) await runIndexerOnce()
    await reconcileMarketplaceStateForWallet(wallet)
    await sendOfferExpiryReminders()
    const marketplaceContractId = process.env.STELLAR_MARKETPLACE_CONTRACT_ID ?? process.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? ''
    const [myListings, myOffers, incomingOffers, seenTokens] = await Promise.all([
      // Listings the wallet currently has live (as seller → can cancel)
      query('SELECT listing_id, contract_id, nft_contract, token_id, price, expires_at, ledger FROM marketplace_listings WHERE contract_id = ? AND seller = ? AND active = TRUE AND expires_at > 0 ORDER BY updated_at DESC LIMIT 100', [marketplaceContractId, wallet]),
      // Offers the wallet has made and can cancel (as buyer)
      query(`SELECT o.offer_id, o.contract_id, o.nft_contract, o.token_id, o.amount, o.expires_at::double precision AS expires_at, o.ledger, r.status AS response_status, r.counter_amount
             FROM marketplace_offers o LEFT JOIN marketplace_offer_responses r ON r.contract_id = o.contract_id AND r.offer_id = o.offer_id
             WHERE o.contract_id = ? AND o.buyer = ? AND o.active = TRUE
             ORDER BY o.updated_at DESC LIMIT 100`, [marketplaceContractId, wallet]),
      // Offers others made on tokens this wallet owns → can accept
      query(`SELECT o.offer_id, o.contract_id, o.nft_contract, o.token_id, o.buyer, o.amount, o.expires_at::double precision AS expires_at, o.ledger, r.status AS response_status, r.counter_amount,
                    COALESCE(NULLIF(m.title, ''), meta.name) AS nft_title, COALESCE(NULLIF(m.image, ''), meta.image) AS nft_image, m.collection_id AS nft_collection_id
             FROM marketplace_offers o
             JOIN nft_ownership n ON n.contract_id = o.nft_contract AND n.token_id = o.token_id
             LEFT JOIN nft_mints m ON LOWER(m.contract_id) = LOWER(o.nft_contract) AND m.token_id = o.token_id
             LEFT JOIN creator_nft_metadata meta ON meta.metadata_uri = m.metadata_uri
             LEFT JOIN marketplace_offer_responses r ON r.contract_id = o.contract_id AND r.offer_id = o.offer_id
             WHERE o.contract_id = ? AND n.owner_address = ? AND o.buyer <> ? AND o.active = TRUE
             ORDER BY o.updated_at DESC LIMIT 100`, [marketplaceContractId, wallet, wallet]),
      // Tokens the wallet owns (for surfacing ownable items)
      query('SELECT contract_id, token_id FROM nft_ownership WHERE owner_address = ? ORDER BY updated_at DESC LIMIT 100', [wallet]),
    ])
    res.json({ wallet, listings: myListings, offers: myOffers, incomingOffers: incomingOffers, ownedTokens: seenTokens })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Marketplace state query failed' })
  }
})

app.post('/api/social/subscriptions/:collectionId', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const collectionId = slug(String(req.params.collectionId))
  const existing = await query<{ collection_id: string }[]>('SELECT collection_id FROM collection_subscriptions WHERE wallet_address = ? AND collection_id = ?', [wallet, collectionId])
  if (existing.length) {
    await query('DELETE FROM collection_subscriptions WHERE wallet_address = ? AND collection_id = ?', [wallet, collectionId])
    return res.json({ subscribed: false, collectionId })
  }
  await query('INSERT INTO collection_subscriptions (wallet_address, collection_id) VALUES (?, ?)', [wallet, collectionId])
  await query('INSERT INTO notifications (wallet_address, kind, title, body) VALUES (?, ?, ?, ?)', [wallet, 'subscription', 'Collection followed', `New drops from ${collectionId} will appear in your feed.`])
  res.status(201).json({ subscribed: true, collectionId })
})

app.get('/api/collections/social', async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  try {
    await ensureSchema()
    const ids = [...new Set(String(req.query.ids ?? '').split(',').map((id) => slug(id)).filter(Boolean))].slice(0, 100)
    if (!ids.length) return res.json({ social: [] })
    let wallet = ''
    try { wallet = await authenticatedWallet(req) ?? '' } catch { /* Collection social counts remain public. */ }
    const [likes, dislikes, comments, viewerLikes, viewerDislikes] = await Promise.all([
      query<{ collection_id: string; count: number }[]>('SELECT collection_id, COUNT(*)::int AS count FROM collection_likes WHERE collection_id = ANY($1::text[]) GROUP BY collection_id', [ids]),
      query<{ collection_id: string; count: number }[]>('SELECT collection_id, COUNT(*)::int AS count FROM collection_dislikes WHERE collection_id = ANY($1::text[]) GROUP BY collection_id', [ids]),
      query<{ id: number; collection_id: string; wallet_address: string; body: string; parent_id: number | null; created_at: string }[]>('SELECT id, collection_id, wallet_address, body, parent_id, created_at FROM collection_comments WHERE collection_id = ANY($1::text[]) ORDER BY created_at ASC', [ids]),
      stellarAddress.test(wallet) ? query<{ collection_id: string }[]>('SELECT collection_id FROM collection_likes WHERE LOWER(wallet_address) = LOWER(?) AND collection_id = ANY($2::text[])', [wallet, ids]) : Promise.resolve([]),
      stellarAddress.test(wallet) ? query<{ collection_id: string }[]>('SELECT collection_id FROM collection_dislikes WHERE LOWER(wallet_address) = LOWER(?) AND collection_id = ANY($2::text[])', [wallet, ids]) : Promise.resolve([]),
    ])
    const likesById = new Map(likes.map((row) => [row.collection_id, Number(row.count)]))
    const dislikesById = new Map(dislikes.map((row) => [row.collection_id, Number(row.count)]))
    const commentsById = new Map<string, typeof comments>()
    comments.forEach((comment) => commentsById.set(comment.collection_id, [...(commentsById.get(comment.collection_id) ?? []), comment]))
    const liked = new Set(viewerLikes.map((row) => row.collection_id))
    const disliked = new Set(viewerDislikes.map((row) => row.collection_id))
    res.json({ social: ids.map((collection_id) => ({ collection_id, likes: likesById.get(collection_id) ?? 0, dislikes: dislikesById.get(collection_id) ?? 0, liked: liked.has(collection_id), disliked: disliked.has(collection_id), comments: (commentsById.get(collection_id) ?? []).map(({ wallet_address: _wallet, ...comment }) => comment) })) })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load collection reactions' })
  }
})

async function socialActorLabel(wallet: string) {
  const rows = await query<{ creator_username: string | null; display_name: string }[]>(
    'SELECT creator_username, display_name FROM user_profiles WHERE LOWER(wallet_address) = LOWER(?) LIMIT 1',
    [wallet],
  )
  const username = rows[0]?.creator_username?.trim().replace(/^@/, '')
  const displayName = rows[0]?.display_name?.trim()
  return username ? `@${username}` : displayName || 'A collector'
}

app.post('/api/collections/:collectionId/like', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const collectionId = slug(String(req.params.collectionId))
  await ensureSchema()
  const existing = await query<{ collection_id: string }[]>('SELECT collection_id FROM collection_likes WHERE LOWER(wallet_address) = LOWER(?) AND collection_id = ?', [wallet, collectionId])
  if (existing.length) {
    await query('DELETE FROM collection_likes WHERE LOWER(wallet_address) = LOWER(?) AND collection_id = ?', [wallet, collectionId])
    return res.json({ liked: false, collectionId })
  }
  await query('DELETE FROM collection_dislikes WHERE LOWER(wallet_address) = LOWER(?) AND collection_id = ?', [wallet, collectionId])
  await query('INSERT INTO collection_likes (wallet_address, collection_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [wallet, collectionId])
  const target = await query<{ owner_wallet: string; name: string }[]>(
    'SELECT owner_wallet, name FROM collections WHERE slug = ? LIMIT 1', [collectionId],
  )
  if (target.length && target[0].owner_wallet.toLowerCase() !== wallet.toLowerCase()) {
    const actor = await socialActorLabel(wallet)
    await notifyUser(target[0].owner_wallet, 'collection_like', 'Your collection got a like', `${actor} liked ${target[0].name}.`, `/collection/${encodeURIComponent(collectionId)}`).catch(() => undefined)
  }
  res.json({ liked: true, collectionId })
})

app.post('/api/collections/:collectionId/dislike', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const collectionId = slug(String(req.params.collectionId))
  await ensureSchema()
  const existing = await query<{ collection_id: string }[]>('SELECT collection_id FROM collection_dislikes WHERE LOWER(wallet_address) = LOWER(?) AND collection_id = ?', [wallet, collectionId])
  if (existing.length) {
    await query('DELETE FROM collection_dislikes WHERE LOWER(wallet_address) = LOWER(?) AND collection_id = ?', [wallet, collectionId])
    return res.json({ disliked: false, collectionId })
  }
  await query('DELETE FROM collection_likes WHERE LOWER(wallet_address) = LOWER(?) AND collection_id = ?', [wallet, collectionId])
  await query('INSERT INTO collection_dislikes (wallet_address, collection_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [wallet, collectionId])
  res.json({ disliked: true, collectionId })
})

app.post('/api/collections/:collectionId/comment', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const collectionId = slug(String(req.params.collectionId))
  const body = String(req.body?.body ?? '').trim().slice(0, 1000)
  const rawParent = req.body?.parentId
  const parentId = rawParent === null || rawParent === undefined ? null : Number(rawParent)
  if (!body) return res.status(400).json({ error: 'Write a comment first' })
  await ensureSchema()
  if (parentId !== null && (!Number.isSafeInteger(parentId) || !(await query<{ id: number }[]>('SELECT id FROM collection_comments WHERE id = ? AND collection_id = ?', [parentId, collectionId])).length)) return res.status(400).json({ error: 'Reply target was not found for this collection' })
  const inserted = await query<{ id: number; created_at: string }[]>('INSERT INTO collection_comments (wallet_address, collection_id, body, parent_id) VALUES (?, ?, ?, ?) RETURNING id, created_at', [wallet, collectionId, body, parentId])
  res.status(201).json({ id: Number(inserted[0].id), collectionId, body, parentId, created_at: inserted[0].created_at })
})

app.post('/api/social/likes/:nftId', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const nftId = slug(String(req.params.nftId))
  const existing = await query<{ nft_id: string }[]>('SELECT nft_id FROM nft_likes WHERE wallet_address = ? AND nft_id = ?', [wallet, nftId])
  if (existing.length) {
    await query('DELETE FROM nft_likes WHERE wallet_address = ? AND nft_id = ?', [wallet, nftId])
    return res.json({ liked: false, nftId })
  }
  await query('DELETE FROM nft_dislikes WHERE wallet_address = ? AND nft_id = ?', [wallet, nftId])
  await query('INSERT INTO nft_likes (wallet_address, nft_id) VALUES (?, ?)', [wallet, nftId])
  res.status(201).json({ liked: true, nftId })
})

// Public aggregate NFT reactions and comments. Personal reaction state is
// included when the caller has a valid wallet session so the same totals and
// threads render consistently across browsers and devices.
app.get('/api/social/nfts', async (req, res) => {
  const ids = [...new Set(String(req.query.ids ?? '').split(',').map((value) => slug(value)).filter(Boolean))].slice(0, 100)
  if (!ids.length) return res.json({ social: [] })
  try {
    const wallet = await authenticatedWallet(req).catch(() => null)
    const [likes, dislikes, comments, mineLikes, mineDislikes] = await Promise.all([
      query<{ nft_id: string; count: number }[]>('SELECT nft_id, COUNT(*)::int AS count FROM nft_likes WHERE nft_id = ANY($1::varchar[]) GROUP BY nft_id', [ids]),
      query<{ nft_id: string; count: number }[]>('SELECT nft_id, COUNT(*)::int AS count FROM nft_dislikes WHERE nft_id = ANY($1::varchar[]) GROUP BY nft_id', [ids]),
      query<{ id: number; nft_id: string; body: string; parent_id: number | null; created_at: string }[]>('SELECT id, nft_id, body, parent_id, created_at FROM nft_comments WHERE nft_id = ANY($1::varchar[]) ORDER BY created_at ASC', [ids]),
      wallet ? query<{ nft_id: string }[]>('SELECT nft_id FROM nft_likes WHERE wallet_address = ? AND nft_id = ANY($2::varchar[])', [wallet, ids]) : Promise.resolve([]),
      wallet ? query<{ nft_id: string }[]>('SELECT nft_id FROM nft_dislikes WHERE wallet_address = ? AND nft_id = ANY($2::varchar[])', [wallet, ids]) : Promise.resolve([]),
    ])
    const likeCounts = new Map(likes.map((row) => [row.nft_id, Number(row.count)]))
    const dislikeCounts = new Map(dislikes.map((row) => [row.nft_id, Number(row.count)]))
    const commentsByNft = new Map<string, typeof comments>()
    for (const comment of comments) commentsByNft.set(comment.nft_id, [...(commentsByNft.get(comment.nft_id) ?? []), comment])
    const liked = new Set(mineLikes.map((row) => row.nft_id))
    const disliked = new Set(mineDislikes.map((row) => row.nft_id))
    res.json({ social: ids.map((nft_id) => ({ nft_id, likes: likeCounts.get(nft_id) ?? 0, dislikes: dislikeCounts.get(nft_id) ?? 0, liked: liked.has(nft_id), disliked: disliked.has(nft_id), comments: commentsByNft.get(nft_id) ?? [] })) })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'NFT social data could not be loaded' })
  }
})

app.post('/api/social/bookmarks/:nftId', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const nftId = slug(String(req.params.nftId))
  const existing = await query<{ nft_id: string }[]>('SELECT nft_id FROM nft_bookmarks WHERE wallet_address = ? AND nft_id = ?', [wallet, nftId])
  if (existing.length) {
    await query('DELETE FROM nft_bookmarks WHERE wallet_address = ? AND nft_id = ?', [wallet, nftId])
    return res.json({ saved: false, nftId })
  }
  await query('INSERT INTO nft_bookmarks (wallet_address, nft_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [wallet, nftId])
  res.status(201).json({ saved: true, nftId })
})

app.post('/api/social/dislikes/:nftId', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const nftId = slug(String(req.params.nftId))
  const existing = await query<{ nft_id: string }[]>('SELECT nft_id FROM nft_dislikes WHERE wallet_address = ? AND nft_id = ?', [wallet, nftId])
  if (existing.length) {
    await query('DELETE FROM nft_dislikes WHERE wallet_address = ? AND nft_id = ?', [wallet, nftId])
    return res.json({ disliked: false, nftId })
  }
  await query('DELETE FROM nft_likes WHERE wallet_address = ? AND nft_id = ?', [wallet, nftId])
  await query('INSERT INTO nft_dislikes (wallet_address, nft_id) VALUES (?, ?)', [wallet, nftId])
  res.status(201).json({ disliked: true, nftId })
})

app.post('/api/social/comments/:nftId', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const nftId = slug(String(req.params.nftId))
  const body = String(req.body?.body ?? '').trim()
  const parentId = req.body?.parentId == null ? null : Number(req.body.parentId)
  if (!body || body.length > 1000) return res.status(400).json({ error: 'Comment must be between 1 and 1000 characters' })
  if (parentId !== null && (!Number.isSafeInteger(parentId) || !(await query<{ id: number }[]>('SELECT id FROM nft_comments WHERE id = ? AND nft_id = ?', [parentId, nftId])).length)) return res.status(400).json({ error: 'Reply target was not found for this NFT' })
  const result = await query<{ id: number }[]>('INSERT INTO nft_comments (wallet_address, nft_id, body, parent_id) VALUES (?, ?, ?, ?) RETURNING id', [wallet, nftId, body, parentId])
  res.status(201).json({ id: result[0]?.id ?? 0, nftId, body, parentId })
})

app.post('/api/notifications/:id/read', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  await query('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND wallet_address = ?', [req.params.id, wallet])
  res.json({ read: true })
})

// ---- Social posts & creator follows ----

// Stories are private to the social graph: creator stories are visible to
// mutual-edge audiences (people the viewer follows or who follow the viewer),
// and collection stories to followers, owners, or current holders.
app.get('/api/collection-stories', requireWallet, async (_req, res) => {
  const wallet = res.locals.wallet as string
  try {
    await ensureSchema()
    const creatorIds = await query<{ creator_wallet: string }[]>(
      `SELECT DISTINCT creator_wallet FROM (
         SELECT COALESCE(p.wallet_address, f.creator_id) AS creator_wallet FROM creator_follows f LEFT JOIN user_profiles p ON LOWER(p.creator_username) = LOWER(f.creator_id) WHERE LOWER(f.wallet_address) = LOWER(?)
         UNION SELECT f.wallet_address AS creator_wallet FROM creator_follows f WHERE LOWER(f.creator_id) = LOWER(?) OR LOWER(f.creator_id) = LOWER(COALESCE((SELECT creator_username FROM user_profiles WHERE LOWER(wallet_address) = LOWER(?)), ''))
         UNION SELECT ? AS creator_wallet
       ) audience`, [wallet, wallet, wallet, wallet],
    )
    const allowedCreators = creatorIds.map((row) => row.creator_wallet)
    const creatorGroups: { kind: 'creator'; collectionId: string; creatorWallet: string; name: string; cover: string; isMine: boolean; stories: object[] }[] = []
    if (allowedCreators.length) {
      const rows = await query<{ creator_wallet: string; display_name: string | null; creator_username: string | null; avatar: string | null; id: number | null; media_url: string | null; media_type: string | null; caption: string | null; created_at: string | null; expires_at: string | null; viewed: boolean | null }[]>(
        `SELECT audience.creator_wallet, p.display_name, p.creator_username, p.avatar,
                s.id, s.media_url, s.media_type, s.caption, s.created_at, s.expires_at,
                EXISTS (SELECT 1 FROM story_views v WHERE v.story_kind = 'creator' AND v.story_id = s.id AND LOWER(v.viewer_wallet) = LOWER(?)) AS viewed
         FROM unnest(?::varchar[]) AS audience(creator_wallet)
         LEFT JOIN user_profiles p ON LOWER(p.wallet_address) = LOWER(audience.creator_wallet)
         LEFT JOIN creator_stories s ON LOWER(s.creator_wallet) = LOWER(audience.creator_wallet) AND s.expires_at > now()
         ORDER BY (LOWER(audience.creator_wallet) = LOWER(?)) DESC, s.created_at ASC NULLS FIRST`,
        [wallet, allowedCreators, wallet],
      )
      const groups = new Map<string, (typeof creatorGroups)[number]>()
      for (const row of rows) {
        const key = row.creator_wallet.toLowerCase()
        let group = groups.get(key)
        if (!group) {
          group = { kind: 'creator', collectionId: `creator:${key}`, creatorWallet: row.creator_wallet, name: row.creator_username ? `@${row.creator_username}` : row.display_name || shortenWallet(row.creator_wallet), cover: row.avatar || '', isMine: key === wallet.toLowerCase(), stories: [] }
          groups.set(key, group)
        }
        if (row.id !== null) group.stories.push({ id: Number(row.id), mediaUrl: row.media_url, mediaType: row.media_type === 'video' ? 'video' : 'image', caption: row.caption, createdAt: row.created_at, expiresAt: row.expires_at, viewed: Boolean(row.viewed) })
      }
      creatorGroups.push(...groups.values())
    }
    const collectionRows = await query<{ collection_id: string; name: string; cover: string; owner_wallet: string; id: number | null; media_url: string | null; media_type: string | null; caption: string | null; created_at: string | null; expires_at: string | null; viewed: boolean | null }[]>(
      `SELECT c.slug AS collection_id, c.name, c.cover, c.owner_wallet,
              s.id, s.media_url, s.media_type, s.caption, s.created_at, s.expires_at,
              EXISTS (SELECT 1 FROM story_views v WHERE v.story_kind = 'collection' AND v.story_id = s.id AND LOWER(v.viewer_wallet) = LOWER(?)) AS viewed
       FROM collections c
       LEFT JOIN collection_stories s ON s.collection_id = c.slug AND s.expires_at > now()
       WHERE LOWER(c.owner_wallet) = LOWER(?)
          OR EXISTS (SELECT 1 FROM collection_subscriptions sub WHERE LOWER(sub.wallet_address) = LOWER(?) AND sub.collection_id = c.slug)
          OR EXISTS (SELECT 1 FROM token_collections tc JOIN nft_ownership own ON own.contract_id = tc.contract_id AND own.token_id = tc.token_id WHERE tc.collection_id = c.slug AND LOWER(own.owner_address) = LOWER(?))
       ORDER BY (LOWER(c.owner_wallet) = LOWER(?)) DESC, s.created_at ASC NULLS FIRST`,
      [wallet, wallet, wallet, wallet, wallet],
    )
    const collectionGroups: { kind: 'collection'; collectionId: string; name: string; cover: string; isMine: boolean; stories: object[] }[] = []
    const groupedCollections = new Map<string, (typeof collectionGroups)[number]>()
    for (const row of collectionRows) {
      let group = groupedCollections.get(row.collection_id)
      if (!group) {
        group = { kind: 'collection', collectionId: row.collection_id, name: row.name, cover: row.cover, isMine: row.owner_wallet.toLowerCase() === wallet.toLowerCase(), stories: [] }
        groupedCollections.set(row.collection_id, group)
      }
      if (row.id !== null) group.stories.push({ id: Number(row.id), mediaUrl: row.media_url, mediaType: row.media_type === 'video' ? 'video' : 'image', caption: row.caption, createdAt: row.created_at, expiresAt: row.expires_at, viewed: Boolean(row.viewed) })
    }
    collectionGroups.push(...[...groupedCollections.values()].filter((group) => group.stories.length > 0))
    const ownStoryGroup = creatorGroups.find((group) => group.isMine)
    const followedCreatorGroups = creatorGroups.filter((group) => !group.isMine && group.stories.length > 0)
    res.json({ groups: [...(ownStoryGroup ? [ownStoryGroup] : []), ...followedCreatorGroups, ...collectionGroups] })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Stories query failed' })
  }
})

app.post('/api/creator-stories', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const mediaUrl = String(req.body?.mediaUrl ?? '').trim().slice(0, 1024)
  const mediaType = String(req.body?.mediaType ?? 'image') === 'video' ? 'video' : 'image'
  const caption = String(req.body?.caption ?? '').trim().slice(0, 500)
  if (!mediaUrl && !caption) return res.status(400).json({ error: 'Add a photo, video, or caption to your status' })
  if (mediaUrl && !/^https?:\/\//i.test(mediaUrl)) return res.status(400).json({ error: 'Story media must be a public http or https URL' })
  await ensureSchema()
  const inserted = await query<{ id: number; created_at: string; expires_at: string }[]>(
    `INSERT INTO creator_stories (creator_wallet, media_url, media_type, caption, expires_at)
     VALUES (?, ?, ?, ?, now() + interval '24 hours') RETURNING id, created_at, expires_at`,
    [wallet, mediaUrl, mediaType, caption],
  )
  res.status(201).json({ story: { id: Number(inserted[0].id), mediaUrl, mediaType, caption, createdAt: inserted[0].created_at, expiresAt: inserted[0].expires_at } })
})

app.post('/api/stories/:kind/:id/viewed', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const kind = req.params.kind === 'creator' || req.params.kind === 'collection' ? req.params.kind : null
  const id = Number(req.params.id)
  if (!kind || !Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid story reference' })
  await ensureSchema()
  let accessible = false
  if (kind === 'creator') {
    accessible = (await query<{ id: number }[]>(
      `SELECT s.id FROM creator_stories s WHERE s.id = ? AND s.expires_at > now() AND (
         LOWER(s.creator_wallet) = LOWER(?) OR EXISTS (SELECT 1 FROM creator_follows f WHERE LOWER(f.wallet_address) = LOWER(?) AND LOWER(f.creator_id) IN (LOWER(s.creator_wallet), LOWER(COALESCE((SELECT creator_username FROM user_profiles WHERE LOWER(wallet_address) = LOWER(s.creator_wallet)), '')))) OR EXISTS (SELECT 1 FROM creator_follows f WHERE LOWER(f.wallet_address) = LOWER(s.creator_wallet) AND LOWER(f.creator_id) IN (LOWER(?), LOWER(COALESCE((SELECT creator_username FROM user_profiles WHERE LOWER(wallet_address) = LOWER(?)), ''))))
       )`, [id, wallet, wallet, wallet, wallet],
    )).length > 0
  } else {
    accessible = (await query<{ id: number }[]>(
      `SELECT s.id FROM collection_stories s JOIN collections c ON c.slug = s.collection_id
       WHERE s.id = ? AND s.expires_at > now() AND (
         LOWER(c.owner_wallet) = LOWER(?) OR EXISTS (SELECT 1 FROM collection_subscriptions sub WHERE LOWER(sub.wallet_address) = LOWER(?) AND sub.collection_id = c.slug) OR EXISTS (SELECT 1 FROM token_collections tc JOIN nft_ownership own ON own.contract_id = tc.contract_id AND own.token_id = tc.token_id WHERE tc.collection_id = c.slug AND LOWER(own.owner_address) = LOWER(?))
       )`, [id, wallet, wallet, wallet],
    )).length > 0
  }
  if (!accessible) return res.status(404).json({ error: 'Story not found or not available to this wallet' })
  await query(`INSERT INTO story_views (story_kind, story_id, viewer_wallet) VALUES (?, ?, ?) ON CONFLICT (story_kind, story_id, viewer_wallet) DO UPDATE SET viewed_at = now()`, [kind, id, wallet])
  res.json({ viewed: true })
})

app.post('/api/collections/:collectionId/stories', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const collectionId = slug(String(req.params.collectionId))
  const mediaUrl = String(req.body?.mediaUrl ?? '').trim().slice(0, 1024)
  const mediaType = String(req.body?.mediaType ?? 'image') === 'video' ? 'video' : 'image'
  const caption = String(req.body?.caption ?? '').trim().slice(0, 500)
  if (!mediaUrl && !caption) return res.status(400).json({ error: 'Add a photo, video, or caption to your story' })
  if (mediaUrl && !/^https?:\/\//i.test(mediaUrl)) return res.status(400).json({ error: 'Story media must be a public http or https URL' })
  await ensureSchema()
  const owned = await query<{ owner_wallet: string }[]>('SELECT owner_wallet FROM collections WHERE slug = ?', [collectionId])
  if (!owned.length) return res.status(404).json({ error: 'Collection not found' })
  if (owned[0].owner_wallet.toLowerCase() !== wallet.toLowerCase()) return res.status(403).json({ error: 'Only the collection owner can publish its story' })
  const inserted = await query<{ id: number; created_at: string; expires_at: string }[]>(
    `INSERT INTO collection_stories (collection_id, owner_wallet, media_url, media_type, caption, expires_at)
     VALUES (?, ?, ?, ?, ?, now() + interval '24 hours') RETURNING id, created_at, expires_at`,
    [collectionId, wallet, mediaUrl, mediaType, caption],
  )
  res.status(201).json({ story: { id: Number(inserted[0].id), mediaUrl, mediaType, caption, createdAt: inserted[0].created_at, expiresAt: inserted[0].expires_at } })
})

app.get('/api/posts', async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  let wallet = ''
  try { wallet = await authenticatedWallet(req) ?? '' } catch { /* Public feed remains readable without personalization. */ }
  try {
    await ensureSchema()
    const collectionId = req.query.collectionId ? slug(String(req.query.collectionId)) : ''
    const creatorWalletRaw = String(req.query.creatorWallet ?? '')
    const creatorWallet = stellarAddress.test(creatorWalletRaw) ? creatorWalletRaw : ''
    const postIdRaw = String(req.query.postId ?? '')
    const postId = /^\d+$/.test(postIdRaw) && Number.isSafeInteger(Number(postIdRaw)) ? Number(postIdRaw) : null
    const rows = await query<{ id: number; author: string; author_name: string; creator_username: string | null; profile_display_name: string | null; avatar: string; media_url: string; media_type: string; caption: string; linked_nft_id: string | null; post_kind: string; author_type: 'user' | 'collection'; collection_id: string | null; price_xlm: string | null; created_at: string; tips_count: number; tips_total_xlm: string }[]>(
      `SELECT posts.id, posts.author, posts.author_name, p.creator_username, p.display_name AS profile_display_name,
              CASE WHEN posts.author_type = 'user' THEN COALESCE(NULLIF(p.avatar, ''), posts.avatar) ELSE posts.avatar END AS avatar,
              posts.media_url, posts.media_type, posts.caption, posts.linked_nft_id, posts.post_kind, posts.author_type, posts.collection_id, posts.price_xlm, posts.created_at,
              (SELECT COUNT(*)::int FROM post_tips pt WHERE pt.post_id = posts.id) AS tips_count,
              COALESCE((SELECT SUM(pt.amount_xlm)::text FROM post_tips pt WHERE pt.post_id = posts.id), '0') AS tips_total_xlm
       FROM posts LEFT JOIN user_profiles p ON p.wallet_address = posts.author
       WHERE COALESCE((to_jsonb(posts)->>'is_demo')::boolean, FALSE) = FALSE
         AND (? = '' OR posts.collection_id = ?)
         AND (? = '' OR lower(posts.author) = lower(?))
         AND (?::bigint IS NULL OR posts.id = ?)
       ORDER BY posts.created_at DESC LIMIT CASE WHEN ?::bigint IS NULL THEN 100 ELSE 1 END`,
      [collectionId, collectionId, creatorWallet, creatorWallet, postId, postId, postId],
    )
    if (rows.length === 0) return res.json({ posts: [] })
    const postIds = rows.map((row) => Number(row.id))
    const [likeCounts, dislikeCounts, commentRows, repostCounts] = await Promise.all([
      query<{ post_id: number; count: number }[]>('SELECT post_id, COUNT(*)::int AS count FROM post_likes WHERE post_id = ANY($1::bigint[]) GROUP BY post_id', [postIds]),
      query<{ post_id: number; count: number }[]>('SELECT post_id, COUNT(*)::int AS count FROM post_dislikes WHERE post_id = ANY($1::bigint[]) GROUP BY post_id', [postIds]),
      query<{ id: number; post_id: number; wallet_address: string; body: string; parent_id: number | null; created_at: string }[]>('SELECT id, post_id, wallet_address, body, parent_id, created_at FROM post_comments WHERE post_id = ANY($1::bigint[]) ORDER BY created_at ASC', [postIds]),
      query<{ post_id: number; count: number }[]>('SELECT post_id, COUNT(*)::int AS count FROM post_reposts WHERE post_id = ANY($1::bigint[]) GROUP BY post_id', [postIds]),
    ])
    const likedSet = new Set<number>()
    const repostSet = new Set<number>()
    if (stellarAddress.test(wallet)) {
      const [pl, pr] = await Promise.all([
        query<{ post_id: number }[]>('SELECT post_id FROM post_likes WHERE wallet_address = ? AND post_id = ANY($2::bigint[])', [wallet, postIds]),
        query<{ post_id: number }[]>('SELECT post_id FROM post_reposts WHERE wallet_address = ? AND post_id = ANY($2::bigint[])', [wallet, postIds]),
      ])
      pl.forEach((r) => likedSet.add(Number(r.post_id)))
      pr.forEach((r) => repostSet.add(Number(r.post_id)))
    }
    const likesByPost = new Map(likeCounts.map((item) => [Number(item.post_id), Number(item.count)]))
    const dislikesByPost = new Map(dislikeCounts.map((item) => [Number(item.post_id), Number(item.count)]))
    const repostsByPost = new Map(repostCounts.map((item) => [Number(item.post_id), Number(item.count)]))
    const commentsByPost = new Map<number, typeof commentRows>()
    for (const comment of commentRows) {
      const postId = Number(comment.post_id)
      const existing = commentsByPost.get(postId) ?? []
      existing.push(comment)
      commentsByPost.set(postId, existing)
    }
    const posts = rows.map((row) => {
      const id = Number(row.id)
      const comments = (commentsByPost.get(id) ?? []).map((comment) => ({ ...comment, wallet_address: 'Collector' }))
      const publicAuthorId = `creator-${crypto.createHash('sha256').update(row.author.toLowerCase()).digest('hex').slice(0, 16)}`
      const authorName = row.author_type === 'collection'
        ? row.author_name
        : row.creator_username ? `@${row.creator_username}` : row.profile_display_name?.trim() || 'Creator'
      const tipRecipient = row.author_type === 'user' && row.post_kind === 'post' && !row.collection_id && !row.linked_nft_id && Boolean(row.media_url) ? row.author : null
      return { ...row, author: publicAuthorId, creator_wallet: row.author_type === 'user' ? row.author : null, tip_recipient: tipRecipient, author_name: authorName, is_me: Boolean(wallet) && row.author.toLowerCase() === wallet.toLowerCase(), creator_username: undefined, profile_display_name: undefined, id, likes: likesByPost.get(id) ?? 0, dislikes: dislikesByPost.get(id) ?? 0, reposts: repostsByPost.get(id) ?? 0, comments, liked: likedSet.has(id), reposted: repostSet.has(id), tips_count: Number(row.tips_count ?? 0), tips_total_xlm: row.tips_total_xlm ?? '0' }
    })
    res.json({ posts })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Posts query failed' })
  }
})

app.post('/api/posts', requireWallet, async (req, res) => {
  await ensureSchema()
  const wallet = res.locals.wallet as string
  const caption = String(req.body?.caption ?? '').trim().slice(0, 1000)
  const mediaUrl = String(req.body?.mediaUrl ?? '').trim().slice(0, 1024)
  const mediaType = String(req.body?.mediaType ?? 'image').slice(0, 32) === 'video' ? 'video' : 'image'
  const linkedNftId = req.body?.linkedNftId ? slug(String(req.body.linkedNftId)) : null
  const collectionId = req.body?.collectionId ? slug(String(req.body.collectionId)) : null
  const kind = String(req.body?.kind ?? 'post') === 'drop' ? 'drop' : 'post'
  const priceRaw = kind === 'drop' ? Number(req.body?.price) : NaN
  if (kind === 'post' && !collectionId && !caption && !mediaUrl && !linkedNftId) return res.status(400).json({ error: 'Add artwork, a caption, or an NFT to share' })
  if (kind === 'post' && collectionId && !caption && !mediaUrl) return res.status(400).json({ error: 'A collection update needs a caption or media' })
  if (kind === 'drop' && !linkedNftId) return res.status(400).json({ error: 'A drop must link an NFT you are issuing' })
  if (kind === 'drop' && (!Number.isFinite(priceRaw) || priceRaw < 0)) return res.status(400).json({ error: 'A drop needs a valid price in XLM' })
  if (kind === 'post' && !collectionId && linkedNftId) {
    const tokenRef = linkedNftId?.match(/^minted-(c[a-z0-9]+)-(\d+)$/)
    if (!tokenRef) return res.status(400).json({ error: 'Choose an NFT from your wallet' })
    const owned = await query<{ owner_address: string }[]>(
      'SELECT owner_address FROM nft_ownership WHERE LOWER(contract_id) = ? AND token_id = ? ORDER BY updated_at DESC LIMIT 1',
      [tokenRef[1], Number(tokenRef[2])],
    )
    if (!owned.length) return res.status(409).json({ error: 'Ownership for this NFT is not indexed yet' })
    if (owned[0].owner_address.toLowerCase() !== wallet.toLowerCase()) return res.status(403).json({ error: 'You can only post NFTs held by your wallet' })
  }
  const priceXlm = kind === 'drop' ? priceRaw : null
  const profile = await query<{ display_name: string; creator_username: string | null; avatar: string }[]>(
    'SELECT display_name, creator_username, avatar FROM user_profiles WHERE wallet_address = ?',
    [wallet],
  )
  const collection = collectionId ? await query<{ slug: string; name: string; cover: string; owner_wallet: string }[]>(
    'SELECT slug, name, cover, owner_wallet FROM collections WHERE slug = ?', [collectionId],
  ) : []
  if (collectionId && !collection.length) return res.status(404).json({ error: 'Collection not found' })
  if (collectionId && collection[0].owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can post as this collection' })
  const authorName = collection[0]?.name || (profile[0]?.creator_username ? `@${profile[0].creator_username}` : profile[0]?.display_name?.trim()) || 'Creator'
  const avatar = collection[0]?.cover || profile[0]?.avatar || ''
  const authorType = collectionId ? 'collection' : 'user'
  const result = await query<{ id: number }[]>(
    'INSERT INTO posts (author, author_name, avatar, caption, media_url, media_type, linked_nft_id, post_kind, price_xlm, author_type, collection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [wallet, authorName, avatar, caption, mediaUrl, mediaType, linkedNftId, kind, priceXlm, authorType, collectionId],
  )
  res.status(201).json({ id: result[0]?.id ?? 0 })
})

app.post('/api/posts/:id/tips', requireWallet, async (req, res) => {
  await ensureSchema()
  const wallet = res.locals.wallet as string
  const postId = Number(req.params.id)
  const txHash = String(req.body?.transactionHash ?? '').trim().toLowerCase()
  if (!Number.isSafeInteger(postId) || postId <= 0) return res.status(400).json({ error: 'Invalid post id' })
  if (!/^[a-f0-9]{64}$/.test(txHash)) return res.status(400).json({ error: 'A valid Stellar transaction hash is required' })
  const post = await query<{ author: string; author_type: string; post_kind: string; collection_id: string | null; linked_nft_id: string | null; media_url: string }[]>(
    'SELECT author, author_type, post_kind, collection_id, linked_nft_id, media_url FROM posts WHERE id = ?', [postId],
  )
  if (!post.length) return res.status(404).json({ error: 'Post not found' })
  const target = post[0]
  if (target.author_type !== 'user' || target.post_kind !== 'post' || target.collection_id || target.linked_nft_id || !target.media_url) return res.status(409).json({ error: 'Tips are available for individual creator art posts that are not linked to an NFT or collection' })
  if (target.author.toLowerCase() === wallet.toLowerCase()) return res.status(400).json({ error: 'You cannot tip your own post' })

  const network = String(process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase()
  const horizon = network === 'PUBLIC' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org'
  try {
    const txResponse = await fetch(`${horizon}/transactions/${txHash}`, { signal: AbortSignal.timeout(10_000) })
    if (!txResponse.ok) return res.status(409).json({ error: 'The tip transaction is not confirmed on the configured Stellar network yet' })
    const tx = await txResponse.json() as { successful?: boolean; source_account?: string; memo_type?: string; memo?: string; ledger?: number }
    if (tx.successful !== true || tx.source_account?.toLowerCase() !== wallet.toLowerCase() || tx.memo_type !== 'text' || tx.memo !== `SN tip ${postId}`) {
      return res.status(400).json({ error: 'This transaction does not match your tip for this art post' })
    }
    const operationResponse = await fetch(`${horizon}/transactions/${txHash}/operations?limit=10`, { signal: AbortSignal.timeout(10_000) })
    if (!operationResponse.ok) return res.status(503).json({ error: 'Could not verify the confirmed tip payment yet' })
    const operationData = await operationResponse.json() as { _embedded?: { records?: { type?: string; from?: string; to?: string; amount?: string; asset_type?: string; source_account?: string }[] } }
    const operations = operationData._embedded?.records ?? []
    if (operations.length !== 1) return res.status(400).json({ error: 'The tip transaction must contain one direct XLM payment' })
    const payment = operations[0]
    const amount = payment.amount ?? ''
    const amountNumber = Number(amount)
    if (payment.type !== 'payment' || payment.asset_type !== 'native' || payment.to?.toLowerCase() !== target.author.toLowerCase() || (payment.from ?? payment.source_account)?.toLowerCase() !== wallet.toLowerCase() || !Number.isFinite(amountNumber) || amountNumber <= 0 || amountNumber > 10_000 || !/^\d+(?:\.\d{1,7})?$/.test(amount)) {
      return res.status(400).json({ error: 'The confirmed transaction is not a valid XLM tip to this creator' })
    }
    const inserted = await query<{ tx_hash: string }[]>(
      'INSERT INTO post_tips (tx_hash, post_id, sender, recipient, amount_xlm, ledger) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tx_hash) DO NOTHING RETURNING tx_hash',
      [txHash, postId, wallet, target.author, amount, Number(tx.ledger ?? 0)],
    )
    if (!inserted.length) {
      const existing = await query<{ post_id: number; sender: string; recipient: string; amount_xlm: string }[]>(
        'SELECT post_id, sender, recipient, amount_xlm FROM post_tips WHERE tx_hash = ?', [txHash],
      )
      if (!existing.length || Number(existing[0].post_id) !== postId || existing[0].sender.toLowerCase() !== wallet.toLowerCase() || existing[0].recipient.toLowerCase() !== target.author.toLowerCase()) {
        return res.status(409).json({ error: 'This Stellar transaction was already recorded for another tip' })
      }
    } else {
      await query('INSERT INTO notifications (wallet_address, kind, title, body) VALUES (?, ?, ?, ?)', [target.author, 'post_tip', 'You received a tip', `${amount} XLM was sent for your art post. https://stellanova-fawn.vercel.app/post/${postId}`])
    }
    const totals = await query<{ tips_count: number; tips_total_xlm: string }[]>(
      'SELECT COUNT(*)::int AS tips_count, COALESCE(SUM(amount_xlm)::text, \'0\') AS tips_total_xlm FROM post_tips WHERE post_id = ?', [postId],
    )
    res.status(inserted.length ? 201 : 200).json({ postId, transactionHash: txHash, amountXlm: amount, duplicate: !inserted.length, tipsCount: Number(totals[0]?.tips_count ?? 0), tipsTotalXlm: totals[0]?.tips_total_xlm ?? '0' })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not verify the tip transaction' })
  }
})

async function postStateForWallet(postId: number, wallet: string): Promise<{ liked: boolean; reposted: boolean }> {
  const [lk, rp] = await Promise.all([
    query<{ c: number }[]>('SELECT COUNT(*) AS c FROM post_likes WHERE wallet_address = ? AND post_id = ?', [wallet, postId]),
    query<{ c: number }[]>('SELECT COUNT(*) AS c FROM post_reposts WHERE wallet_address = ? AND post_id = ?', [wallet, postId]),
  ])
  return { liked: Number(lk[0]?.c ?? 0) > 0, reposted: Number(rp[0]?.c ?? 0) > 0 }
}

app.post('/api/posts/:id/like', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const postId = Number(req.params.id)
  const existing = await query<{ post_id: number }[]>('SELECT post_id FROM post_likes WHERE wallet_address = ? AND post_id = ?', [wallet, postId])
  if (existing.length) {
    await query('DELETE FROM post_likes WHERE wallet_address = ? AND post_id = ?', [wallet, postId])
    return res.json({ liked: false, postId })
  }
  await query('DELETE FROM post_dislikes WHERE wallet_address = ? AND post_id = ?', [wallet, postId])
  await query('INSERT INTO post_likes (wallet_address, post_id) VALUES (?, ?)', [wallet, postId])
  const target = await query<{ author: string; author_type: string; collection_id: string | null; owner_wallet: string | null; caption: string }[]>(
    `SELECT p.author, p.author_type, p.collection_id, c.owner_wallet, p.caption
     FROM posts p LEFT JOIN collections c ON c.slug = p.collection_id WHERE p.id = ? LIMIT 1`,
    [postId],
  )
  const recipient = target[0]?.author_type === 'collection' ? target[0]?.owner_wallet : target[0]?.author
  if (recipient && recipient.toLowerCase() !== wallet.toLowerCase()) {
    const actor = await socialActorLabel(wallet)
    const postLabel = target[0].caption.trim().slice(0, 100)
    const body = postLabel ? `${actor} liked your post: “${postLabel}”` : `${actor} liked your post.`
    await notifyUser(recipient, 'post_like', 'Your post got a like', body, `/post/${postId}`).catch(() => undefined)
  }
  res.status(201).json({ liked: true, postId })
})

app.post('/api/posts/:id/dislike', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const postId = Number(req.params.id)
  if (!Number.isSafeInteger(postId) || postId <= 0) return res.status(400).json({ error: 'Invalid post id' })
  const existing = await query<{ post_id: number }[]>('SELECT post_id FROM post_dislikes WHERE wallet_address = ? AND post_id = ?', [wallet, postId])
  if (existing.length) {
    await query('DELETE FROM post_dislikes WHERE wallet_address = ? AND post_id = ?', [wallet, postId])
    return res.json({ disliked: false, postId })
  }
  await query('DELETE FROM post_likes WHERE wallet_address = ? AND post_id = ?', [wallet, postId])
  await query('INSERT INTO post_dislikes (wallet_address, post_id) VALUES (?, ?)', [wallet, postId])
  res.status(201).json({ disliked: true, postId })
})

app.post('/api/posts/:id/comment', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const postId = Number(req.params.id)
  const body = String(req.body?.body ?? '').trim()
  const parentId = req.body?.parentId == null ? null : Number(req.body.parentId)
  if (!body || body.length > 1000) return res.status(400).json({ error: 'Comment must be between 1 and 1000 characters' })
  if (!Number.isSafeInteger(postId) || postId <= 0) return res.status(400).json({ error: 'Invalid post id' })
  if (parentId !== null && (!Number.isSafeInteger(parentId) || !(await query<{ id: number }[]>('SELECT id FROM post_comments WHERE id = ? AND post_id = ?', [parentId, postId])).length)) return res.status(400).json({ error: 'Reply target was not found for this post' })
  const result = await query<{ id: number }[]>('INSERT INTO post_comments (wallet_address, post_id, body, parent_id) VALUES (?, ?, ?, ?) RETURNING id', [wallet, postId, body, parentId])
  res.status(201).json({ id: result[0]?.id ?? 0, postId, body, parentId })
})

app.post('/api/posts/:id/repost', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const postId = Number(req.params.id)
  const existing = await query<{ post_id: number }[]>('SELECT post_id FROM post_reposts WHERE wallet_address = ? AND post_id = ?', [wallet, postId])
  if (existing.length) {
    await query('DELETE FROM post_reposts WHERE wallet_address = ? AND post_id = ?', [wallet, postId])
    return res.json({ reposted: false, postId })
  }
  await query('INSERT INTO post_reposts (wallet_address, post_id) VALUES (?, ?)', [wallet, postId])
  res.status(201).json({ reposted: true, postId })
})

app.get('/api/creators/profiles', async (req, res) => {
  const wallets = [...new Set(String(req.query.wallets ?? '').split(',').filter((wallet) => stellarAddress.test(wallet)))].slice(0, 100)
  if (!wallets.length) return res.json({ profiles: [] })
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  try {
    await ensureSchema()
    const profiles = await query<{
      wallet_address: string; display_name: string; creator_username: string | null; avatar: string; bio: string; is_creator: boolean; is_verified: boolean;
      collection_count: number; collector_count: number
    }[]>(
      `SELECT p.wallet_address, p.display_name, p.creator_username, p.avatar, p.bio, p.is_creator, p.is_verified,
              COUNT(DISTINCT c.id)::int AS collection_count,
              (SELECT COUNT(*)::int FROM creator_follows f WHERE lower(f.creator_id) = lower(p.wallet_address)) AS collector_count
       FROM user_profiles p
       LEFT JOIN collections c ON c.owner_wallet = p.wallet_address
       WHERE p.wallet_address = ANY(?::varchar[])
       GROUP BY p.wallet_address, p.display_name, p.creator_username, p.avatar, p.bio, p.is_creator, p.is_verified`,
      [wallets],
    )
    res.json({ profiles })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Creator profiles are unavailable' })
  }
})

// Resolve a creator's shareable public profile by username or wallet address.
app.get('/api/creators/profile/:id', async (req, res) => {
  const identifier = String(req.params.id ?? '').trim().replace(/^@/, '')
  const isWallet = stellarAddress.test(identifier)
  if (!isWallet && !/^[a-z][a-z0-9_]{2,23}$/i.test(identifier)) return res.status(400).json({ error: 'Use a creator username or Stellar address' })
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  try {
    await ensureSchema()
    const profiles = await query<{
      wallet_address: string; display_name: string; creator_username: string | null; avatar: string; bio: string; is_creator: boolean; is_verified: boolean;
      collection_count: number; collector_count: number
    }[]>(
      `SELECT p.wallet_address, p.display_name, p.creator_username, p.avatar, p.bio, p.is_creator, p.is_verified,
              COUNT(DISTINCT c.id)::int AS collection_count,
              (SELECT COUNT(*)::int FROM creator_follows f WHERE lower(f.creator_id) = lower(p.wallet_address)) AS collector_count
       FROM user_profiles p
       LEFT JOIN collections c ON lower(c.owner_wallet) = lower(p.wallet_address)
       WHERE ( ? = TRUE AND lower(p.wallet_address) = lower(?) ) OR lower(p.creator_username) = lower(?)
       GROUP BY p.wallet_address, p.display_name, p.creator_username, p.avatar, p.bio, p.is_creator, p.is_verified
       LIMIT 1`,
      [isWallet, identifier, identifier],
    )
    if (!profiles.length) return res.status(404).json({ error: 'Creator profile not found' })
    return res.json({ profile: profiles[0] })
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Creator profile is unavailable' })
  }
})

app.post('/api/creators/:id/follow', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const creatorId = slug(String(req.params.id))
  const existing = await query<{ creator_id: string }[]>('SELECT creator_id FROM creator_follows WHERE wallet_address = ? AND creator_id = ?', [wallet, creatorId])
  if (existing.length) {
    await query('DELETE FROM creator_follows WHERE wallet_address = ? AND creator_id = ?', [wallet, creatorId])
    return res.json({ followed: false, creatorId })
  }
  await query('INSERT INTO creator_follows (wallet_address, creator_id) VALUES (?, ?)', [wallet, creatorId])
  res.status(201).json({ followed: true, creatorId })
})

// ---- Wallet accounts, creator onboarding, wallet-owned collections ----
// Mirrors OpenSea's model: one account per wallet, no rigid roles. A wallet
// becomes a creator by creating a collection (no application gate). Verification
// (the "creator" badge) is an opt-in admin-reviewed step on top of that.

app.post('/api/nft/contracts/register', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const contractId = String(req.body?.contractId ?? '').trim()
  const network = String(process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase()
  if (network !== 'TESTNET') return res.status(409).json({ error: 'StellaNova creator contracts can only be registered on Stellar Testnet' })
  if (!/^C[A-Z2-7]{55}$/.test(contractId)) return res.status(400).json({ error: 'A valid Soroban contract ID is required' })
  try {
    await ensureSchema()
    await query('INSERT INTO nft_contract_registry (contract_id, owner_wallet, network) VALUES (?, ?, ?) ON CONFLICT (contract_id) DO NOTHING', [contractId, wallet, network])
    res.status(201).json({ registered: true, contractId, network })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'NFT contract registration failed' })
  }
})

app.get('/api/account', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  try {
    await ensureSchema()
    const rows = await query<{ display_name: string; creator_username: string | null; avatar: string; bio: string; is_creator: boolean; is_admin: boolean; is_verified: boolean }[]>(
      'SELECT display_name, creator_username, avatar, bio, is_creator, is_admin, is_verified FROM user_profiles WHERE wallet_address = ?',
      [wallet],
    )
    const collections = await query<{ id: number; slug: string; name: string; symbol: string; description: string; cover: string; contract_id: string | null; total_supply: number | null; website_url: string | null; social_links: Record<string, string> }[]>(
      'SELECT id, slug, name, symbol, description, cover, contract_id, total_supply, website_url, social_links FROM collections WHERE owner_wallet = ? ORDER BY created_at ASC',
      [wallet],
    )
    if (!rows.length) return res.json({ account: null, isCreator: false, isAdmin: false, collections })
    const profile = rows[0]
    res.json({ account: { ...profile, wallet_address: wallet }, isCreator: profile.is_creator, isAdmin: profile.is_admin, collections })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Account query failed' })
  }
})

app.post('/api/account/profile', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const hasCreatorUsername = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'creatorUsername')
  const rawCreatorUsername = hasCreatorUsername ? String(req.body?.creatorUsername ?? '').trim().replace(/^@/, '').toLowerCase() : null
  if (rawCreatorUsername && !/^[a-z][a-z0-9_]{2,23}$/.test(rawCreatorUsername)) {
    return res.status(400).json({ error: 'Username must be 3–24 characters, start with a letter, and use only letters, numbers, or underscores.' })
  }
  try {
    await ensureSchema()
    const current = await query<{ display_name: string; avatar: string; bio: string; creator_username: string | null }[]>(
      'SELECT display_name, avatar, bio, creator_username FROM user_profiles WHERE wallet_address = ?',
      [wallet],
    )
    const displayName = String(req.body?.displayName ?? current[0]?.display_name ?? '').trim().slice(0, 80)
    const avatar = String(req.body?.avatar ?? current[0]?.avatar ?? '').trim().slice(0, 512)
    const bio = String(req.body?.bio ?? current[0]?.bio ?? '').trim().slice(0, 500)
    const creatorUsername = rawCreatorUsername === null ? current[0]?.creator_username ?? null : rawCreatorUsername || null
    if (creatorUsername) {
      const duplicate = await query<{ wallet_address: string }[]>(
        'SELECT wallet_address FROM user_profiles WHERE lower(creator_username) = lower(?) AND wallet_address <> ? LIMIT 1',
        [creatorUsername, wallet],
      )
      if (duplicate.length) return res.status(409).json({ error: 'That username is already taken. Try another one.' })
    }
    await query(
      'INSERT INTO user_profiles (wallet_address, display_name, avatar, bio, creator_username) VALUES (?, ?, ?, ?, ?) ON CONFLICT (wallet_address) DO UPDATE SET display_name = ?, avatar = ?, bio = ?, creator_username = ?, updated_at = now()',
      [wallet, displayName, avatar, bio, creatorUsername, displayName, avatar, bio, creatorUsername],
    )
    res.json({ ok: true, creatorUsername: creatorUsername ?? '' })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      return res.status(409).json({ error: 'That username is already taken. Try another one.' })
    }
    res.status(503).json({ error: error instanceof Error ? error.message : 'Profile update failed' })
  }
})

app.post('/api/account/collections', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const name = String(req.body?.name ?? '').trim().slice(0, 160)
  const symbol = String(req.body?.symbol ?? '').trim().toUpperCase().slice(0, 20)
  const description = String(req.body?.description ?? '').trim().slice(0, 1000)
  const cover = String(req.body?.cover ?? '').trim().slice(0, 1024)
  const rawTotalSupply = req.body?.totalSupply
  const totalSupply = rawTotalSupply === null || rawTotalSupply === undefined || rawTotalSupply === '' ? null : Number(rawTotalSupply)
  const contractId = String(req.body?.contractId ?? '').trim()
  if (!name || !symbol) return res.status(400).json({ error: 'A collection needs a name and a symbol' })
  if (totalSupply !== null && (!Number.isSafeInteger(totalSupply) || totalSupply < 1 || totalSupply > 10000000)) return res.status(400).json({ error: 'Set a total supply between 1 and 10,000,000, or leave it open' })
  if (!/^C[A-Z2-7]{55}$/.test(contractId)) return res.status(400).json({ error: 'Deploy the current NFT contract on Testnet before creating a collection' })
  const baseSlug = slug(symbol.toLowerCase() + '-' + name)
  try {
    await ensureSchema()
    const contract = await query<{ contract_id: string }[]>('SELECT contract_id FROM nft_contract_registry WHERE contract_id = ? AND network = ?', [contractId, 'TESTNET'])
    if (!contract.length) return res.status(409).json({ error: 'Register the deployed Testnet NFT contract before creating a collection' })
    // Uniquify slug against existing collections to avoid collisions.
    let slugValue = baseSlug
    for (let attempt = 0; attempt < 10; attempt++) {
      const clash = await query<{ id: number }[]>('SELECT id FROM collections WHERE slug = ?', [slugValue])
      if (!clash.length) break
      slugValue = `${baseSlug}-${attempt + 2}`
    }
    const result = await query<{ id: number }[]>(
      'INSERT INTO collections (owner_wallet, slug, name, symbol, description, cover, contract_id, total_supply) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [wallet, slugValue, name, symbol, description, cover, contractId, totalSupply],
    )
    // Creating a collection is the permissionless act that makes this wallet a creator.
    await query(
      `INSERT INTO user_profiles (wallet_address, display_name, is_creator) VALUES (?, ?, TRUE)
       ON CONFLICT (wallet_address) DO UPDATE SET is_creator = TRUE, updated_at = now()`,
      [wallet, name],
    )
    res.status(201).json({ id: result[0]?.id ?? 0, slug: slugValue, contractId, totalSupply, isCreator: true })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not create collection' })
  }
})

// ---- Collection mint timeline (drop stages + whitelists) ----
// Grounded in the OpenSea/SeaDrop model: a collection drop runs as ordered mint
// stages (up to 5 presale: team / guaranteed / fcfs) plus a mandatory final
// public stage. Each stage has its own window, price and per-wallet limit, and
// presale stages are gated by a per-stage allowlist (wallet → custom limit/price).
const MINT_KINDS = ['team', 'guaranteed', 'fcfs', 'public'] as const
function hasValidXlmPrecision(raw: unknown, amount: number) {
  if (typeof raw === 'string') return /^\d+(?:\.\d{1,7})?$/.test(raw.trim())
  const stroops = amount * 10_000_000
  return Number.isSafeInteger(Math.round(stroops)) && Math.abs(stroops - Math.round(stroops)) < 0.0001
}
async function collectionBySlug(slugValue: string) {
  const rows = await query<{ id: number; owner_wallet: string; name: string; symbol: string; cover: string | null; contract_id: string | null; total_supply: number | null }[]>(
    'SELECT id, owner_wallet, name, symbol, cover, contract_id, total_supply FROM collections WHERE slug = ?',
    [slugValue],
  )
  if (rows[0]) return rows[0]
  return null
}

// Creator drop wizard draft. Artwork, dates, stage settings and allowlists are
// saved here before any mint-stage transaction is published on-chain.
app.get('/api/collections/:slug/drop/setup', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can view this setup draft' })
    const rows = await query<{ setup: Record<string, unknown> }[]>('SELECT setup FROM collection_drop_drafts WHERE collection_id = ?', [slugValue])
    res.json({ setup: rows[0]?.setup ?? { startTime: '', artwork: [], stages: [], allowlists: {} } })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load collection setup' })
  }
})

app.get('/api/collections/:slug/drop/setup/reset-plan', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can clear this setup' })
    const saved = await query<{ setup: Record<string, unknown> }[]>('SELECT setup FROM collection_drop_drafts WHERE collection_id = ?', [slugValue])
    if ((saved[0]?.setup as any)?.launched) return res.status(409).json({ error: 'This drop is already launched and cannot be cleared as a draft.' })
    const minted = await query<{ count: number }[]>('SELECT COUNT(*)::int AS count FROM nft_mints WHERE collection_id = ?', [slugValue])
    if (Number(minted[0]?.count ?? 0) > 0) return res.status(409).json({ error: 'This collection has minted NFTs, so its setup cannot be reset.' })
    const stages = await query<{ id: number; kind: string; is_published: boolean }[]>('SELECT id, kind, is_published FROM mint_stages WHERE collection_id = ?', [slugValue])
    if (stages.some((stage) => stage.is_published || stage.kind === 'public')) return res.status(409).json({ error: 'A published or public stage exists. Remove or finish that drop before starting over.' })
    const contracts = await query<{ contract_id: string }[]>("SELECT contract_id FROM nft_contract_registry WHERE network = 'TESTNET' ORDER BY created_at DESC")
    res.json({ stageIds: stages.map((stage) => Number(stage.id)), candidateContractIds: contracts.map((row) => row.contract_id) })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not prepare collection setup reset' })
  }
})

app.put('/api/collections/:slug/drop/setup', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const setup = req.body?.setup
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) return res.status(400).json({ error: 'A collection setup draft is required' })
  const serialized = JSON.stringify(setup)
  if (serialized.length > 2_000_000) return res.status(413).json({ error: 'Setup draft is too large' })
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can save this setup' })
    await query(
      `INSERT INTO collection_drop_drafts (collection_id, owner_wallet, setup) VALUES (?, ?, ?::jsonb)
       ON CONFLICT (collection_id) DO UPDATE SET setup = EXCLUDED.setup, updated_at = now() WHERE collection_drop_drafts.owner_wallet = EXCLUDED.owner_wallet`,
      [slugValue, wallet, serialized],
    )
    res.json({ saved: true, setup })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not save collection setup' })
  }
})

app.delete('/api/collections/:slug/drop/setup', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const removedStageIds = Array.isArray(req.body?.removedStageIds)
    ? [...new Set<number>(req.body.removedStageIds.map(Number).filter((id: number) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)
    : []
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can clear this setup' })
    await withTransaction(async () => {
      const locked = await query<{ id: number }[]>('SELECT id FROM collections WHERE slug = ? AND owner_wallet = ? FOR UPDATE', [slugValue, wallet])
      if (!locked.length) throw new Error('RESET_CONFLICT:Collection ownership changed; reload and try again.')
      const saved = await query<{ setup: Record<string, unknown> }[]>('SELECT setup FROM collection_drop_drafts WHERE collection_id = ? FOR UPDATE', [slugValue])
      if ((saved[0]?.setup as any)?.launched) throw new Error('RESET_CONFLICT:This drop is already launched and cannot be cleared as a draft.')
      const minted = await query<{ count: number }[]>('SELECT COUNT(*)::int AS count FROM nft_mints WHERE collection_id = ?', [slugValue])
      if (Number(minted[0]?.count ?? 0) > 0) throw new Error('RESET_CONFLICT:This collection has minted NFTs, so its setup cannot be reset.')
      const stages = await query<{ id: number; kind: string; is_published: boolean; metadata_uri: string; metadata_uris: string[] | null }[]>(
        'SELECT id, kind, is_published, metadata_uri, metadata_uris FROM mint_stages WHERE collection_id = ? FOR UPDATE', [slugValue],
      )
      if (stages.some((stage) => stage.is_published || stage.kind === 'public')) throw new Error('RESET_CONFLICT:A published or public stage exists. Remove or finish that drop before starting over.')
      const expectedIds = stages.map((stage) => Number(stage.id)).sort((a, b) => a - b)
      if (expectedIds.length !== removedStageIds.length || expectedIds.some((id, index) => id !== removedStageIds[index])) {
        throw new Error('RESET_CONFLICT:Saved stages changed. Reload the setup and try clearing it again.')
      }
      const ids = expectedIds
      if (ids.length) {
        const uris = stages.flatMap((stage) => [stage.metadata_uri, ...(Array.isArray(stage.metadata_uris) ? stage.metadata_uris : [])]).filter(Boolean)
        await query('DELETE FROM mint_whitelist WHERE stage_id = ANY(?::bigint[])', [ids])
        if (uris.length) await query('DELETE FROM creator_nft_metadata WHERE collection_id = ? AND metadata_uri = ANY(?::varchar[])', [slugValue, [...new Set(uris)]])
        await query('DELETE FROM mint_stages WHERE collection_id = ? AND id = ANY(?::bigint[]) AND is_published = FALSE', [slugValue, ids])
      }
      await query('DELETE FROM collection_drop_drafts WHERE collection_id = ? AND owner_wallet = ?', [slugValue, wallet])
    })
    res.json({ cleared: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not clear collection setup'
    if (message.startsWith('RESET_CONFLICT:')) return res.status(409).json({ error: message.slice('RESET_CONFLICT:'.length) })
    res.status(503).json({ error: message })
  }
})

app.post('/api/collections/:slug/reveal', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const revealed = req.body?.revealed === true
  const placeholderUri = String(req.body?.placeholderUri ?? '').trim().slice(0, 1024)
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection creator can change reveal state' })
    if (!revealed) {
      if (!/^https:\/\//i.test(placeholderUri)) return res.status(400).json({ error: 'Upload a public placeholder metadata document before unrevealing' })
      const placeholder = await query<{ metadata_uri: string }[]>(
        'SELECT metadata_uri FROM creator_nft_metadata WHERE metadata_uri = ? AND collection_id = ? AND creator_wallet = ? LIMIT 1',
        [placeholderUri, slugValue, wallet],
      )
      if (!placeholder.length) return res.status(400).json({ error: 'Placeholder metadata must belong to this collection' })
    }
    await query('UPDATE collections SET revealed = ?, placeholder_metadata_uri = COALESCE(NULLIF(?, \'\'), placeholder_metadata_uri) WHERE slug = ?', [revealed, placeholderUri, slugValue])
    res.json({ revealed, placeholderMetadataUri: placeholderUri || null })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not update collection reveal state' })
  }
})

// Creator-only metadata handoff used after the on-chain reveal flag is set.
// Actual token URLs never appear in unauthenticated collection/stage responses.
app.get('/api/collections/:slug/reveal/metadata', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection creator can reveal token metadata' })
    if (!collection.contract_id) return res.status(409).json({ error: 'This collection has no registered NFT contract' })
    const tokens = await query<{ contract_id: string; token_id: number; metadata_uri: string }[]>(
      'SELECT contract_id, token_id, metadata_uri FROM nft_mints WHERE collection_id = ? ORDER BY contract_id ASC, token_id ASC',
      [slugValue],
    )
    if (tokens.some((token) => !/^https:\/\//i.test(token.metadata_uri))) return res.status(409).json({ error: 'Some minted tokens are still missing metadata. Retry after mint indexing finishes.' })
    const registeredContracts = await query<{ contract_id: string }[]>(
      'SELECT contract_id FROM collection_nft_contracts WHERE collection_slug = ? UNION SELECT contract_id FROM nft_mints WHERE collection_id = ? ORDER BY contract_id',
      [slugValue, slugValue],
    )
    const contractIds = [...new Set([collection.contract_id, ...registeredContracts.map((row) => row.contract_id)].filter((id): id is string => Boolean(id)))]
    res.json({ tokens, contractIds })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not load reveal metadata' })
  }
})

// Public: read the drop schedule + (if requested by an owner) the allowlist.
app.get('/api/collections', async (_req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  try {
    await ensureSchema()
    const rows = await query(
      `SELECT c.id, c.slug, c.name, c.symbol, c.description, c.cover, c.owner_wallet,
              c.contract_id, c.total_supply, c.website_url, c.social_links, c.revealed, c.is_verified, c.verification_status, COALESCE(m.nft_count, 0)::int AS nft_count,
              EXISTS (
                SELECT 1 FROM mint_stages s
                LEFT JOIN LATERAL (
                  SELECT COUNT(DISTINCT tokens.token_id)::int AS minted_count
                  FROM stage_mint_events e CROSS JOIN LATERAL unnest(e.token_ids) AS tokens(token_id)
                  WHERE e.stage_id = s.id
                ) stage_mints ON TRUE
                WHERE s.collection_id = c.slug AND s.is_published = TRUE
                  AND (s.start_time IS NULL OR s.start_time <= NOW())
                  AND (s.end_time IS NULL OR s.end_time >= NOW())
                  AND (s.max_supply IS NULL OR COALESCE(stage_mints.minted_count, 0) < s.max_supply)
              ) AS minting_now
       FROM collections c
       LEFT JOIN (SELECT collection_id, COUNT(*) AS nft_count FROM nft_mints GROUP BY collection_id) m
         ON m.collection_id = c.slug
       ORDER BY c.created_at DESC LIMIT 200`,
    )
    res.json({ collections: rows })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Collections query failed' })
  }
})

app.post('/api/collections/:slug/royalty-registry', requireWallet, async (req, res) => {
  const wallet = String(res.locals.wallet ?? '')
  const slug = String(req.params.slug ?? '').trim().toLowerCase()
  const marketplaceId = process.env.STELLAR_MARKETPLACE_CONTRACT_ID ?? process.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? ''
  const secret = process.env.STELLAR_DEPLOYER_SECRET ?? ''
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return res.status(400).json({ error: 'Invalid collection.' })
  if ((process.env.VITE_STELLAR_NETWORK ?? process.env.STELLAR_NETWORK ?? 'TESTNET').toUpperCase() !== 'TESTNET') return res.status(503).json({ error: 'Legacy royalty registration is currently enabled on Testnet only.' })
  if (!/^C[A-Z2-7]{55}$/.test(marketplaceId) || !secret) return res.status(503).json({ error: 'The Testnet marketplace admin signer is not configured.' })
  try {
    await ensureSchema()
    const collection = await query<{ owner_wallet: string; contract_id: string | null }[]>(
      'SELECT owner_wallet, contract_id FROM collections WHERE slug = ? LIMIT 1', [slug],
    )
    if (!collection.length || collection[0].owner_wallet.toLowerCase() !== wallet.toLowerCase()) return res.status(403).json({ error: 'Only this collection’s recorded creator can configure royalties.' })
    const nftContract = collection[0].contract_id ?? ''
    if (!/^C[A-Z2-7]{55}$/.test(nftContract)) return res.status(409).json({ error: 'This collection has no deployed NFT contract.' })
    const tokenRows = await query<{ token_id: number }[]>(
      'SELECT token_id FROM nft_mints WHERE LOWER(contract_id) = LOWER(?) AND collection_id = ? ORDER BY token_id', [nftContract, slug],
    )
    const keypair = StellarSdk.Keypair.fromSecret(secret)
    const rpcUrl = process.env.STELLAR_RPC_URL ?? process.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'
    const rpc = new StellarSdk.rpc.Server(rpcUrl)
    const tokenIds = tokenRows.map((row) => Number(row.token_id)).filter((id) => Number.isInteger(id) && id >= 0)
    const batches: number[][] = []
    if (!tokenIds.length) batches.push([])
    else for (let i = 0; i < tokenIds.length; i += 100) batches.push(tokenIds.slice(i, i + 100))
    for (const batch of batches) {
      const account = await rpc.getAccount(keypair.publicKey())
      const operation = new StellarSdk.Contract(marketplaceId).call(
        'register_legacy_collection',
        StellarSdk.nativeToScVal(nftContract, { type: 'address' }),
        StellarSdk.nativeToScVal(slug, { type: 'string' }),
        StellarSdk.nativeToScVal(wallet, { type: 'address' }),
        StellarSdk.nativeToScVal(batch, { type: 'u32' }),
      )
      const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.TESTNET })
        .addOperation(operation as never).setTimeout(60).build()
      const prepared = await rpc.prepareTransaction(tx)
      prepared.sign(keypair)
      const sent = await rpc.sendTransaction(prepared)
      if (sent.status === 'ERROR') throw new Error('Stellar RPC rejected the legacy royalty registry transaction.')
      let confirmed = false
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const result = await rpc.getTransaction(sent.hash)
        if (result.status === 'SUCCESS') { confirmed = true; break }
        if (result.status === 'FAILED') throw new Error('The marketplace rejected legacy royalty registration. Confirm its admin signer matches STELLAR_DEPLOYER_SECRET and deploy the updated marketplace contract.')
      }
      if (!confirmed) throw new Error('Legacy royalty registration confirmation timed out. Retry saving the royalty.')
    }
    res.json({ registered: true, tokenCount: tokenIds.length })
  } catch (error) {
    console.error('Legacy creator royalty registry failed:', error)
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not register this collection for royalties.' })
  }
})

app.get('/api/collections/:slug/mint-history', async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  const slugValue = slug(String(req.params.slug))
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection?.contract_id) return res.status(404).json({ error: 'Collection contract not found' })
    const stageRows = await query<{ wallet: string; stage_name: string; stage_minted: number; last_ledger: number }[]>(
      `SELECT v.minter AS wallet, COALESCE(NULLIF(s.name, ''), s.kind, 'Direct mint') AS stage_name,
              COUNT(*)::int AS stage_minted, MAX(v.ledger)::int AS last_ledger
       FROM verified_nft_mints v
       JOIN nft_mints m ON LOWER(m.contract_id) = LOWER(v.contract_id) AND m.token_id = v.token_id
       LEFT JOIN mint_stages s ON s.id = m.stage_id AND s.collection_id = m.collection_id
       WHERE m.collection_id = ?
       GROUP BY v.minter, s.name, s.kind ORDER BY v.minter, stage_name`,
      [slugValue],
    )
    const historyByWallet = new Map<string, { wallet: string; total_minted: number; last_ledger: number; stages: { stage_name: string; stage_minted: number }[] }>()
    for (const stage of stageRows) {
      const key = stage.wallet.toLowerCase()
      const entry = historyByWallet.get(key) ?? { wallet: stage.wallet, total_minted: 0, last_ledger: stage.last_ledger, stages: [] }
      entry.total_minted += stage.stage_minted
      entry.last_ledger = Math.max(entry.last_ledger, stage.last_ledger)
      entry.stages.push({ stage_name: stage.stage_name, stage_minted: stage.stage_minted })
      historyByWallet.set(key, entry)
    }
    const history = [...historyByWallet.values()].sort((a, b) => b.total_minted - a.total_minted || a.wallet.localeCompare(b.wallet))
    res.json({ collection: slugValue, wallets: history })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Mint history query failed' })
  }
})

app.put('/api/collections/:slug/profile', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const normalizeWebUrl = (input: unknown, platform?: string) => {
    let value = String(input ?? '').trim().slice(0, 500)
    if (!value) return ''
    if ((/^@?[a-z\d_]{1,30}$/i.test(value) || value.startsWith('@')) && platform) {
      const handle = value.replace(/^@/, '')
      const hosts: Record<string, string> = { x: 'x.com', instagram: 'instagram.com', youtube: 'youtube.com' }
      const host = hosts[platform]
      if (host) value = `${host}/${platform === 'youtube' ? '@' : ''}${handle}`
      else return value
    }
    if (value.startsWith('//')) value = value.slice(2)
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`
    return value
  }
  const websiteUrl = normalizeWebUrl(req.body?.websiteUrl)
  const cover = typeof req.body?.cover === 'string' ? req.body.cover.trim().slice(0, 1024) : undefined
  const submittedLinks = req.body?.socialLinks && typeof req.body.socialLinks === 'object' ? req.body.socialLinks : {}
  const socialLinks: Record<string, string> = {}
  for (const key of ['instagram', 'x', 'discord', 'youtube']) {
    const value = normalizeWebUrl(submittedLinks[key], key)
    if (value) socialLinks[key] = value
  }
  const validWebUrl = (value: string) => {
    try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' } catch { return false }
  }
  if (websiteUrl && !validWebUrl(websiteUrl)) return res.status(400).json({ error: 'Website must be a valid http or https URL' })
  if (cover && !validWebUrl(cover)) return res.status(400).json({ error: 'Collection image must be a valid http or https URL' })
  if (Object.values(socialLinks).some((value) => !validWebUrl(value))) return res.status(400).json({ error: 'Social links must be valid http or https URLs' })
  try {
    await ensureSchema()
    const collection = await query<{ owner_wallet: string; cover: string }[]>('SELECT owner_wallet, cover FROM collections WHERE slug = ?', [slugValue])
    if (!collection.length) return res.status(404).json({ error: 'Collection not found' })
    if (collection[0].owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can edit its public information' })
    await query('UPDATE collections SET website_url = ?, social_links = ?::jsonb, cover = COALESCE(?, cover) WHERE slug = ?', [websiteUrl || null, JSON.stringify(socialLinks), cover, slugValue])
    res.json({ updated: true, websiteUrl: websiteUrl || null, socialLinks, cover: cover ?? collection[0].cover ?? '' })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not update collection information' })
  }
})

app.get('/api/collections/:slug/drop', async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  const slugValue = slug(String(req.params.slug))
  let wallet = ''
  try { wallet = await authenticatedWallet(req) ?? '' } catch { /* Public stage data remains available without owner privileges. */ }
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    const isOwner = stellarAddress.test(wallet) && wallet === collection.owner_wallet
    const publicStages = await query<{ id: number; kind: string; name: string; start_time: string | null; end_time: string | null; price_xlm: string | null; per_wallet_limit: number; max_supply: number | null; sort_order: number; metadata_uri: string; metadata_uris: string[]; edition_count: number; metadata_name: string; metadata_image: string }[]>(
      'SELECT id, kind, name, start_time, end_time, price_xlm, per_wallet_limit, max_supply, sort_order, metadata_uri, metadata_uris, edition_count, metadata_name, metadata_image FROM mint_stages WHERE collection_id = ? AND is_published = TRUE ORDER BY sort_order ASC, id ASC',
      [slugValue],
    )
    // Only the owner sees the full allowlist; others just get counts.
    let whitelist: { stage_id: number; wallet: string; custom_limit: number | null; custom_price: string | null }[] = []
    if (stellarAddress.test(wallet) && wallet === collection.owner_wallet) {
      whitelist = await query('SELECT stage_id, wallet, custom_limit, custom_price FROM mint_whitelist WHERE stage_id IN (SELECT id FROM mint_stages WHERE collection_id = ?)', [slugValue])
    }
    const countRows = await query<{ stage_id: number; c: number }[]>(
      'SELECT stage_id, COUNT(*) AS c FROM mint_whitelist WHERE stage_id IN (SELECT id FROM mint_stages WHERE collection_id = ?) GROUP BY stage_id',
      [slugValue],
    )
    const counts: Record<number, number> = {}
    for (const row of countRows) counts[row.stage_id] = Number(row.c)
    const reveal = await query<{ revealed: boolean; placeholder_metadata_uri: string | null }[]>('SELECT revealed, placeholder_metadata_uri FROM collections WHERE slug = ?', [slugValue])
    const revealed = reveal[0]?.revealed ?? true
    const safeStages = publicStages.map(stage => revealed || isOwner ? stage : { ...stage, metadata_uri: '', metadata_uris: [], metadata_name: 'Unrevealed NFT', metadata_image: '' })
    res.json({ collection: { id: collection.id, slug: slugValue, name: collection.name, symbol: collection.symbol, contractId: collection.contract_id, revealed, placeholderMetadataUri: reveal[0]?.placeholder_metadata_uri ?? null }, stages: safeStages, whitelist, whitelistCounts: counts, isOwner })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Drop query failed' })
  }
})

// Owner: create a mint stage.
app.post('/api/collections/:slug/drop/stages', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const kind = String(req.body?.kind ?? '')
  const isDraft = req.body?.draft === true
  if (!MINT_KINDS.includes(kind as any)) return res.status(400).json({ error: 'kind must be team, guaranteed, fcfs or public' })
  const name = String(req.body?.name ?? '').trim().slice(0, 160)
  const startRaw = req.body?.startTime
  const endRaw = req.body?.endTime
  const startTime = startRaw ? new Date(startRaw) : null
  const endTime = endRaw ? new Date(endRaw) : null
  if (!startTime || !endTime) return res.status(400).json({ error: 'Every mint stage needs a start and end time' })
  if (startTime && Number.isNaN(startTime.getTime())) return res.status(400).json({ error: 'Invalid startTime' })
  if (endTime && Number.isNaN(endTime.getTime())) return res.status(400).json({ error: 'Invalid endTime' })
  if (startTime && endTime && startTime.getTime() >= endTime.getTime()) return res.status(400).json({ error: 'startTime must be before endTime' })
  const price = req.body?.price === undefined || req.body?.price === null || req.body?.price === '' ? null : Number(req.body.price)
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1_000_000 || !hasValidXlmPrecision(req.body.price, price))) return res.status(400).json({ error: 'Price must be between 0 and 1,000,000 XLM with no more than 7 decimal places' })
  const perWalletLimit = Number(req.body?.perWalletLimit ?? 1)
  let maxSupply = req.body?.maxSupply === undefined || req.body?.maxSupply === null || req.body?.maxSupply === '' ? null : Number(req.body.maxSupply)
  const requestedUris = Array.isArray(req.body?.metadataUris) ? req.body.metadataUris : [req.body?.metadataUri]
  const metadataUris = [...new Set(requestedUris.map((uri: unknown) => String(uri ?? '').trim()).filter((uri: string) => /^https:\/\//i.test(uri)))].slice(0, 10000)
  const metadataUri = metadataUris[0] ?? ''
  if (!Number.isSafeInteger(perWalletLimit) || perWalletLimit < 1 || perWalletLimit > 1000) return res.status(400).json({ error: 'perWalletLimit must be between 1 and 1000' })
  if (maxSupply !== null && (!Number.isSafeInteger(maxSupply) || maxSupply < 1 || maxSupply > 1_000_000)) return res.status(400).json({ error: 'maxSupply must be a positive whole number' })
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can configure its drop' })
    if (!collection.contract_id) return res.status(409).json({ error: 'This collection has no registered NFT contract' })
    if (collection.total_supply !== null) {
      const [minted, stages] = await Promise.all([
        query<{ count: number }[]>('SELECT COUNT(*)::int AS count FROM nft_mints m WHERE collection_id = ? AND (stage_id IS NULL OR NOT EXISTS (SELECT 1 FROM mint_stages s WHERE s.id = m.stage_id))', [slugValue]),
        query<{ reserved: number; unlimited: number }[]>('SELECT COALESCE(SUM(max_supply), 0)::int AS reserved, COUNT(*) FILTER (WHERE max_supply IS NULL)::int AS unlimited FROM mint_stages WHERE collection_id = ?', [slugValue]),
      ])
      const alreadyMinted = Number(minted[0]?.count ?? 0)
      const alreadyReserved = Number(stages[0]?.reserved ?? 0)
      if (Number(stages[0]?.unlimited ?? 0) > 0) return res.status(400).json({ error: 'An earlier stage has no finite supply; remove it before adding another stage' })
      if (maxSupply === null) {
        maxSupply = collection.total_supply - alreadyMinted - alreadyReserved
        if (maxSupply < 1) return res.status(400).json({ error: `The collection supply of ${collection.total_supply} is fully minted or reserved` })
      }
      if (alreadyMinted + alreadyReserved + Number(maxSupply) > collection.total_supply) {
        return res.status(400).json({ error: `This stage would exceed the collection supply of ${collection.total_supply}` })
      }
    }
    if (!metadataUri) return res.status(400).json({ error: 'Upload the stage artwork and metadata before creating the stage' })
    const metadata = await query<{ metadata_uri: string; name: string; image: string }[]>(
      'SELECT metadata_uri, name, image FROM creator_nft_metadata WHERE metadata_uri = ANY(?::varchar[]) AND collection_id = ? AND creator_wallet = ?',
      [metadataUris, slugValue, wallet],
    )
    if (metadata.length !== metadataUris.length) return res.status(400).json({ error: 'One or more edition metadata documents do not belong to this collection' })
    // Enforce at most 5 presale stages + a single final public stage.
    const kinds = await query<{ kind: string }[]>('SELECT kind FROM mint_stages WHERE collection_id = ?', [slugValue])
    const presaleCount = kinds.filter((k) => k.kind !== 'public').length
    if (kind === 'public' && kinds.some((k) => k.kind === 'public')) return res.status(400).json({ error: 'A collection already has a public stage' })
    if (kind !== 'public' && kinds.some((k) => k.kind === 'public')) return res.status(400).json({ error: 'Presale stages must be created before the public stage' })
    if (kind !== 'public' && presaleCount >= 5) return res.status(400).json({ error: 'A collection can have at most 5 presale stages' })
    const sortOrder = await query<{ m: number }[]>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS m FROM mint_stages WHERE collection_id = ?', [slugValue])
    const stageOrder = Number(sortOrder[0]?.m ?? 0)
    let candidateId = 0
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = crypto.randomInt(1, 0x1_0000_0000)
      const occupied = await query<{ id: number }[]>('SELECT id FROM mint_stages WHERE id = ? LIMIT 1', [candidate])
      if (!occupied.length) { candidateId = candidate; break }
    }
    if (!candidateId) return res.status(503).json({ error: 'Could not allocate an on-chain stage ID; try again' })
    const result = await query<{ id: number }[]>(
      'INSERT INTO mint_stages (id, collection_id, kind, name, start_time, end_time, price_xlm, per_wallet_limit, max_supply, sort_order, metadata_uri, metadata_uris, edition_count, metadata_name, metadata_image, is_published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?) RETURNING id',
      [candidateId, slugValue, kind, name, startTime, endTime, price, perWalletLimit, maxSupply, stageOrder, metadataUri, JSON.stringify(metadataUris), metadataUris.length, metadata[0].name, metadata[0].image, !isDraft],
    )
    const id = Number(result[0]?.id ?? 0)
    if (!Number.isSafeInteger(id) || id < 0 || id > 0xffff_ffff) return res.status(503).json({ error: 'Mint stage sequence has exceeded the on-chain stage ID range' })
    res.status(201).json({ id, slug: slugValue, kind, name, sortOrder: stageOrder, metadataUri, metadataUris, metadataName: metadata[0].name, metadataImage: metadata[0].image })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not create mint stage' })
  }
})

app.post('/api/collections/:slug/drop/stages/:id/publish', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const stageId = Number(req.params.id)
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can publish its drop' })
    const result = await query('UPDATE mint_stages SET is_published = TRUE, updated_at = now() WHERE id = ? AND collection_id = ? RETURNING id', [stageId, slugValue])
    if (!result.length) return res.status(404).json({ error: 'Mint stage was not found in this collection; it was not marked as published' })
    res.json({ published: true, id: stageId })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not publish mint stage' })
  }
})

// Owner: replace metadata on a saved stage that has not been published yet.
app.put('/api/collections/:slug/drop/stages/:id/metadata', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const stageId = Number(req.params.id)
  const metadataUris = Array.isArray(req.body?.metadataUris)
    ? [...new Set(req.body.metadataUris.map((uri: unknown) => String(uri ?? '').trim()).filter((uri: string) => /^https:\/\//i.test(uri)))].slice(0, 10000)
    : []
  if (!Number.isSafeInteger(stageId) || stageId < 1 || stageId > 0xffff_ffff) return res.status(400).json({ error: 'Invalid mint stage ID' })
  if (!metadataUris.length) return res.status(400).json({ error: 'Stage metadata is required' })
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can update its drop' })
    const stage = await query<{ id: number; is_published: boolean }[]>('SELECT id, is_published FROM mint_stages WHERE id = ? AND collection_id = ?', [stageId, slugValue])
    if (!stage.length) return res.status(404).json({ error: 'Mint stage not found' })
    if (stage[0].is_published) return res.status(409).json({ error: 'This stage is already published and its artwork metadata is locked' })
    const metadata = await query<{ metadata_uri: string; name: string; image: string }[]>(
      'SELECT metadata_uri, name, image FROM creator_nft_metadata WHERE metadata_uri = ANY(?::varchar[]) AND collection_id = ? AND creator_wallet = ?',
      [metadataUris, slugValue, wallet],
    )
    if (metadata.length !== metadataUris.length) return res.status(400).json({ error: 'One or more metadata documents do not belong to this collection' })
    await query(
      'UPDATE mint_stages SET metadata_uri = ?, metadata_uris = ?::jsonb, edition_count = ?, metadata_name = ?, metadata_image = ?, updated_at = now() WHERE id = ? AND collection_id = ? AND is_published = FALSE',
      [metadataUris[0], JSON.stringify(metadataUris), metadataUris.length, metadata[0].name, metadata[0].image, stageId, slugValue],
    )
    res.json({ id: stageId, metadataUri: metadataUris[0], metadataUris })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not update stage metadata' })
  }
})

// Owner: delete a mint stage.
app.delete('/api/collections/:slug/drop/stages/:id', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const stageId = Number(req.params.id)
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can edit its drop' })
    const stage = await query<{ id: number; kind: string; metadata_uri: string }[]>('SELECT id, kind, metadata_uri FROM mint_stages WHERE id = ? AND collection_id = ?', [stageId, slugValue])
    if (!stage.length) return res.status(404).json({ error: 'Mint stage not found' })
    if (stage[0].kind === 'public') return res.status(400).json({ error: 'The public stage cannot be deleted' })
    await query('DELETE FROM mint_whitelist WHERE stage_id = ?', [stageId])
    await query('DELETE FROM mint_stages WHERE id = ?', [stageId])
    res.json({ deleted: true, id: stageId })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not delete mint stage' })
  }
})

// Owner: add whitelist entries to a stage (wallet → custom limit/price).
app.post('/api/collections/:slug/drop/whitelist', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const stageId = Number(req.body?.stageId)
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : []
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can edit the allowlist' })
    const stage = await query<{ id: number; kind: string }[]>('SELECT id, kind FROM mint_stages WHERE id = ? AND collection_id = ?', [stageId, slugValue])
    if (!stage.length) return res.status(404).json({ error: 'Mint stage not found' })
    if (stage[0].kind === 'public') return res.status(400).json({ error: 'The public stage has no allowlist' })
    let added = 0
    for (const entry of entries) {
      const entryWallet = String(entry?.wallet ?? '').trim()
      if (!stellarAddress.test(entryWallet)) continue
      const customLimit = entry?.customLimit === undefined || entry?.customLimit === null || entry?.customLimit === '' ? null : Number(entry.customLimit)
      const customPrice = entry?.customPrice === undefined || entry?.customPrice === null || entry?.customPrice === '' ? null : Number(entry.customPrice)
      if (customLimit !== null && (!Number.isSafeInteger(customLimit) || customLimit < 1 || customLimit > 1000)) return res.status(400).json({ error: 'Custom wallet limits must be whole numbers between 1 and 1000' })
      if (customPrice !== null && (!Number.isFinite(customPrice) || customPrice < 0 || customPrice > 1_000_000 || !hasValidXlmPrecision(entry.customPrice, customPrice))) return res.status(400).json({ error: 'Custom prices must be between 0 and 1,000,000 XLM with no more than 7 decimal places' })
      await query(
        'INSERT INTO mint_whitelist (stage_id, wallet, custom_limit, custom_price) VALUES (?, ?, ?, ?) ON CONFLICT (stage_id, wallet) DO UPDATE SET custom_limit = EXCLUDED.custom_limit, custom_price = EXCLUDED.custom_price',
        [stageId, entryWallet, customLimit, customPrice],
      )
      added += 1
    }
    res.status(201).json({ added, stageId, slug: slugValue })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not update allowlist' })
  }
})

// Owner: remove a wallet from a stage's allowlist.
app.delete('/api/collections/:slug/drop/whitelist/:stageId/:wallet', requireWallet, async (req, res) => {
  const wallet = res.locals.wallet as string
  const slugValue = slug(String(req.params.slug))
  const stageId = Number(req.params.stageId)
  const entryWallet = String(req.params.wallet)
  if (!Number.isSafeInteger(stageId) || stageId < 1 || stageId > 0xffff_ffff || !stellarAddress.test(entryWallet)) return res.status(400).json({ error: 'Invalid stage ID or Stellar wallet address' })
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    if (collection.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection owner can edit the allowlist' })
    const stage = await query<{ id: number; kind: string }[]>('SELECT id, kind FROM mint_stages WHERE id = ? AND collection_id = ?', [stageId, slugValue])
    if (!stage.length) return res.status(404).json({ error: 'Mint stage not found' })
    if (stage[0].kind === 'public') return res.status(400).json({ error: 'The public stage has no allowlist' })
    await query('DELETE FROM mint_whitelist WHERE stage_id = ? AND wallet = ?', [stageId, entryWallet])
    res.json({ removed: true, stageId, wallet: entryWallet })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Could not remove allowlist entry' })
  }
})

// Anyone: query a wallet's eligibility across a collection's mint stages.
// Mirrors OpenSea's additive-allowlist semantics (limits roll forward, and the
// public stage always adds on top) and labels the request as guaranteed / fcfs /
// team / public so the UI can show the right experience.
app.get('/api/collections/:slug/drop/eligibility', async (req, res) => {
  if (!databaseAvailable()) return res.status(503).json({ error: 'Persistent database is not configured' })
  const slugValue = slug(String(req.params.slug))
  const wallet = String(req.query.wallet ?? '')
  const validWallet = stellarAddress.test(wallet) ? wallet : null
  try {
    await ensureSchema()
    const collection = await collectionBySlug(slugValue)
    if (!collection) return res.status(404).json({ error: 'Collection not found' })
    const stages = await query<{ id: number; kind: string; name: string; start_time: string | null; end_time: string | null; price_xlm: string | null; per_wallet_limit: number; max_supply: number | null; sort_order: number; metadata_uri: string; metadata_uris: string[]; metadata_name: string; metadata_image: string }[]>(
      'SELECT id, kind, name, start_time, end_time, price_xlm, per_wallet_limit, max_supply, sort_order, metadata_uri, metadata_uris, metadata_name, metadata_image FROM mint_stages WHERE collection_id = ? AND is_published = TRUE ORDER BY sort_order ASC, id ASC',
      [slugValue],
    )
    const nowMs = Date.now()
    // Number of public / total NFTs to infer FCFS (over-allocated) vs guaranteed.
    const result: any[] = []
    for (const stage of stages) {
      const startMs = stage.start_time ? new Date(stage.start_time).getTime() : null
      const endMs = stage.end_time ? new Date(stage.end_time).getTime() : null
      const isPublic = stage.kind === 'public'
      if (!isPublic && !validWallet) continue // presale eligibility needs a wallet
      let onAllowlist = false
      let customLimit: number | null = null
      let customPrice: string | null = null
      if (validWallet) {
        const wl = await query<{ custom_limit: number | null; custom_price: string | null }[]>(
          'SELECT custom_limit, custom_price FROM mint_whitelist WHERE stage_id = ? AND wallet = ?',
          [stage.id, wallet],
        )
        if (wl.length) { onAllowlist = true; customLimit = wl[0].custom_limit; customPrice = wl[0].custom_price }
      }
      const mintTotals = await query<{ stage_minted: number; wallet_minted: number }[]>(
        `SELECT COALESCE(SUM(CARDINALITY(token_ids)), 0)::int AS stage_minted,
                COALESCE(SUM(CASE WHEN LOWER(wallet) = LOWER(?) THEN CARDINALITY(token_ids) ELSE 0 END), 0)::int AS wallet_minted
         FROM stage_mint_events e
         WHERE e.stage_id = ? AND LOWER(e.contract_id) IN (
           SELECT LOWER(contract_id) FROM collection_nft_contracts WHERE collection_slug = ?
         )`,
        [wallet || '', stage.id, slugValue],
      )
      const stageMinted = Number(mintTotals[0]?.stage_minted ?? 0)
      const walletMinted = Number(mintTotals[0]?.wallet_minted ?? 0)
      const walletLimit = customLimit ?? stage.per_wallet_limit
      // Guaranteed vs FCFS only applies to allowlisted presale stages: guaranteed
      // when per-wallet allowances can't collectively exceed supply; otherwise FCFS.
      const status = isPublic ? 'public' : !validWallet ? 'restricted' : onAllowlist ? (stage.kind === 'team' ? 'team' : stage.max_supply && stage.per_wallet_limit >= stage.max_supply ? 'guaranteed' : 'fcfs') : 'not-whitelisted'
      const isActive = (startMs === null || startMs <= nowMs) && (endMs === null || endMs >= nowMs)
      result.push({
        stageId: stage.id,
        kind: stage.kind,
        name: stage.name || humanizeKind(stage.kind),
        startTime: stage.start_time,
        endTime: stage.end_time,
        price: stage.price_xlm,
        perWalletLimit: walletLimit,
        walletMinted,
        stageMinted,
        remainingForWallet: Math.max(0, walletLimit - walletMinted),
        remainingSupply: stage.max_supply === null ? null : Math.max(0, stage.max_supply - stageMinted),
        maxSupply: stage.max_supply,
        metadataUri: stage.metadata_uri,
        metadataUris: stage.metadata_uris ?? [stage.metadata_uri],
        metadataName: stage.metadata_name,
        metadataImage: stage.metadata_image,
        onAllowlist,
        customPrice,
        status,
        active: isActive,
      })
    }
    const reveal = await query<{ revealed: boolean; placeholder_metadata_uri: string | null }[]>('SELECT revealed, placeholder_metadata_uri FROM collections WHERE slug = ?', [slugValue])
    const revealed = reveal[0]?.revealed ?? true
    const safeResult = revealed ? result : result.map(stage => ({ ...stage, metadataUri: '', metadataUris: [], metadataName: 'Unrevealed NFT', metadataImage: '' }))
    res.json({ collection: { slug: slugValue, name: collection.name, contractId: collection.contract_id, revealed, placeholderMetadataUri: reveal[0]?.placeholder_metadata_uri ?? null }, wallet: validWallet, now: new Date().toISOString(), stages: safeResult })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Eligibility query failed' })
  }
})

function humanizeKind(kind: string): string {
  switch (kind) {
    case 'team': return 'Team mint'
    case 'guaranteed': return 'Guaranteed mint'
    case 'fcfs': return 'FCFS mint'
    case 'public': return 'Public mint'
    default: return kind
  }
}

// ---- Admin: collection verification ----
// Verification is collection-level (the buyer-facing trust signal at the point
// of sale) and is decided by an admin. Approving a collection also marks its
// owner as a verified creator (the secondary "known artist" badge), but the two
// stay separable: a verified user's unverified collections remain unverified.

app.get('/api/admin/collections/review', requireAdmin, async (req, res) => {
  const status = String(req.query?.status ?? 'pending')
  try {
    await ensureSchema()
    const valid = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending'
    const rows = await query<{ id: number; slug: string; name: string; symbol: string; description: string; cover: string; owner_wallet: string; is_verified: boolean; verification_status: string; verified_by: string | null; verified_at: string | null; created_at: string }[]>(
      'SELECT id, slug, name, symbol, description, cover, owner_wallet, is_verified, verification_status, verified_by, verified_at, created_at FROM collections WHERE verification_status = ? ORDER BY created_at ASC',
      [valid],
    )
    const withOwner = []
    for (const row of rows) {
      const owner = await query<{ display_name: string }[]>('SELECT display_name FROM user_profiles WHERE wallet_address = ?', [row.owner_wallet])
      withOwner.push({ ...row, owner_name: owner[0]?.display_name ?? '' })
    }
    res.json({ collections: withOwner })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Review query failed' })
  }
})

app.post('/api/admin/collections/:id/verify', requireAdmin, async (req, res) => {
  const admin = res.locals.wallet as string
  const id = Number(req.params.id)
  const action = String(req.body?.action ?? 'approve')
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Action must be approve or reject' })
  try {
    await ensureSchema()
    const col = await query<{ id: number; owner_wallet: string }[]>('SELECT id, owner_wallet FROM collections WHERE id = ?', [id])
    if (!col.length) return res.status(404).json({ error: 'Collection not found' })
    const isVerified = action === 'approve'
    const status = action === 'approve' ? 'approved' : 'rejected'
    await query(
      'UPDATE collections SET is_verified = ?, verification_status = ?, verified_by = ?, verified_at = now() WHERE id = ?',
      [isVerified, status, admin, id],
    )
    const message = isVerified ? `Collection #${id} approved` : `Collection #${id} rejected`
    // Collection-approval marks the owner as a verified creator (secondary badge).
    if (isVerified) {
      await query('UPDATE user_profiles SET is_verified = TRUE, updated_at = now() WHERE wallet_address = ?', [col[0].owner_wallet])
    }
    res.json({ ok: true, id, isVerified, verificationStatus: status })
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Verification update failed' })
  }
})

app.get('/api/mail/status', requireAdmin, (_req, res) => {
  res.json({ configured: mailConfigured(), host: process.env.SMTP_HOST ?? null })
})

function requireUploadToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!uploadToken) return res.status(503).json({ error: 'Media upload authorization is not configured' })
  if (!constantTimeStringEqual(uploadToken, req.header('x-nftgram-upload-token') ?? '')) return res.status(401).json({ error: 'Invalid media upload authorization' })
  next()
}

async function requireMediaAuthorization(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authorization = req.header('authorization') ?? ''
  const suppliedWalletSession = authorization.startsWith('Bearer ') || Boolean(req.header('x-stellar-address'))
  if (suppliedWalletSession) {
    if (!databaseAvailable()) return res.status(503).json({ error: 'Wallet upload authorization is temporarily unavailable. Try again shortly.' })
    try {
      const wallet = await authenticatedWallet(req)
      if (!wallet) return res.status(401).json({ error: 'Your Stellar wallet session expired. Reconnect your wallet, then try minting again.' })
      res.locals.wallet = wallet
      return next()
    } catch (error) {
      console.error('Wallet media authorization lookup failed:', error)
      return res.status(503).json({ error: 'Wallet upload authorization is temporarily unavailable. Try again shortly.' })
    }
  }
  // The upload token is reserved for explicit server-side/admin uploads. Never
  // downgrade a wallet-authenticated request to this separate credential.
  return requireUploadToken(req, res, next)
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'asset'
}

function shortenWallet(wallet: string) {
  return wallet.length > 10 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet
}

function sha256(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function constantTimeStringEqual(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected)
  const suppliedBytes = Buffer.from(supplied)
  return expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes)
}

function cloudinarySignature(params: Record<string, string>) {
  const payload = Object.entries(params).filter(([, value]) => value !== '').sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&')
  return crypto.createHash('sha1').update(`${payload}${process.env.CLOUDINARY_API_SECRET}`).digest('hex')
}

async function putToR2(file: Express.Multer.File, key: string) {
  if (!r2) return null
  await r2.send(new PutObjectCommand({
    Bucket: process.env.CLOUDFLARE_R2_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  const base = r2PublicBaseUrl()
  return base ? `${base}/${key}` : null
}

async function putToCloudinary(file: Express.Multer.File, publicId: string) {
  if (!cloudinaryEnabled) return null
  const timestamp = String(Math.floor(Date.now() / 1000))
  const params = { folder: 'nftgram/originals', public_id: publicId, timestamp }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname)
  form.append('api_key', process.env.CLOUDINARY_API_KEY!)
  form.append('timestamp', timestamp)
  form.append('folder', params.folder)
  form.append('public_id', publicId)
  form.append('signature', cloudinarySignature(params))
  const response = await fetch(`https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/auto/upload`, { method: 'POST', body: form })
  const body = await response.json() as { secure_url?: string; error?: { message?: string } }
  if (!response.ok || !body.secure_url) throw new Error(body.error?.message || 'Cloudinary upload failed')
  return body.secure_url
}

function supportedMediaType(contentType: string, fileName: string) {
  const extension = path.extname(fileName).toLowerCase()
  if (contentType === 'application/octet-stream' && extension === '.glb') return 'model/gltf-binary'
  if (contentType === 'application/octet-stream' && extension === '.gltf') return 'model/gltf+json'
  if (/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|mp4|wav|ogg|webm)|model\/(gltf-binary|gltf\+json))$/.test(contentType)) return contentType
  return null
}

// Browser MIME headers are user-controlled. Verify signatures before media is
// stored or sent to an image-analysis provider; the allowlist above alone does
// not establish the file's real format.
function mediaSignatureMatches(bytes: Buffer, contentType: string): boolean {
  const startsWith = (...signature: number[]) => bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value)
  switch (contentType) {
    case 'image/png': return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'image/jpeg': return startsWith(0xff, 0xd8, 0xff)
    case 'image/webp': return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    case 'image/gif': return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
    case 'video/mp4':
    case 'audio/mp4': return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp'
    case 'video/webm': return startsWith(0x1a, 0x45, 0xdf, 0xa3)
    case 'audio/wav': return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
    case 'audio/ogg': return bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS'
    case 'audio/mpeg': return (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') || startsWith(0xff, bytes[1] & 0xe0)
    case 'model/gltf-binary': return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'glTF' && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length
    case 'model/gltf+json':
      try {
        const document = JSON.parse(bytes.toString('utf8')) as { asset?: { version?: unknown } }
        return Boolean(document && typeof document === 'object' && document.asset && document.asset.version === '2.0')
      } catch { return false }
    default: return false
  }
}

app.get('/api/media/providers', (_req, res) => {
  const r2Readiness = r2ProductionReadiness()
  const cloudinaryDeliveryBaseUrl = process.env.CLOUDINARY_DELIVERY_BASE_URL
    || (process.env.CLOUDINARY_CLOUD_NAME ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload` : null)
  res.json({
    cloudinary: { enabled: cloudinaryEnabled, deliveryBaseUrl: cloudinaryDeliveryBaseUrl },
    cloudflare: { enabled: r2Enabled, publicBaseUrl: r2Readiness.baseUrl, productionDomain: r2Readiness.productionDomain, onR2Dev: r2Readiness.describesOnR2Dev },
    canonicalProvider: cloudinaryEnabled ? 'cloudinary' : r2Enabled ? 'cloudflare-r2' : null,
    metadataProvider: r2Enabled ? 'cloudflare-r2' : null,
  })
})

// Cloudinary remains the canonical media host. This same-origin route is only
// used by the UI after a browser cannot load a Cloudinary image directly.
app.get('/api/media/proxy', async (req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME
  const value = String(req.query.url ?? '')
  if (!cloudName || value.length > 2_048) return res.status(400).end()
  let assetUrl: URL
  try {
    assetUrl = new URL(value)
  } catch {
    return res.status(400).end()
  }
  const allowedPath = `/${cloudName}/image/upload/`
  if (assetUrl.protocol !== 'https:' || assetUrl.hostname !== 'res.cloudinary.com' || !assetUrl.pathname.startsWith(allowedPath)) {
    return res.status(400).end()
  }
  try {
    // Do not follow redirects from a third-party media URL. This route is a
    // constrained Cloudinary image relay; redirects could otherwise turn it
    // into an SSRF proxy before the final URL is checked.
    const upstream = await fetch(assetUrl, { redirect: 'manual', signal: AbortSignal.timeout(12_000) })
    const finalUrl = new URL(upstream.url)
    const contentType = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
    if (!upstream.ok || finalUrl.hostname !== 'res.cloudinary.com' || !/^image\/(png|jpeg|webp|gif)$/.test(contentType)) {
      await upstream.body?.cancel().catch(() => {})
      return res.status(502).end()
    }
    const declaredSize = Number(upstream.headers.get('content-length') ?? 0)
    if (declaredSize > 10 * 1024 * 1024) {
      await upstream.body?.cancel().catch(() => {})
      return res.status(413).end()
    }
    const bytes = Buffer.from(await upstream.arrayBuffer())
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return res.status(413).end()
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', String(bytes.length))
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(bytes)
  } catch {
    res.status(502).end()
  }
})

app.get('/api/media/health', (_req, res) => {
  // Uploads work with either configured provider. Requiring both here marked
  // a healthy R2-only deployment as unavailable, even though the upload route
  // already treats providers as independent fallbacks.
  const configured = (cloudinaryEnabled || r2Enabled) && Boolean(uploadToken)
  const r2Readiness = r2ProductionReadiness()
  res.status(configured ? 200 : 503).json({
    configured,
    cloudinary: cloudinaryEnabled,
    cloudflare: r2Enabled,
    uploadAuthorization: Boolean(uploadToken),
    r2: r2Readiness,
  })
})

// Return a short-lived upload signature so browsers can send artwork directly
// to Cloudinary. This keeps media bytes out of Vercel's 4.5 MB function limit.
app.post('/api/media/upload-signature', processRateLimit('media-signature', 30, 10 * 60_000), requireMediaAuthorization, (req, res) => {
  if (!cloudinaryEnabled) return res.status(503).json({ error: 'Cloudinary direct uploads are not configured' })
  const fileName = String(req.body?.fileName ?? '').trim().slice(0, 240)
  const contentType = supportedMediaType(String(req.body?.contentType ?? ''), fileName)
  const bytes = Number(req.body?.bytes)
  const digest = String(req.body?.sha256 ?? '').toLowerCase()
  if (!fileName || !contentType || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 25 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(digest)) {
    return res.status(400).json({ error: 'Upload needs a supported file, SHA-256 digest and size up to 25 MB' })
  }
  const collectionId = slug(String(req.body?.collection ?? 'unfiled'))
  const base = `${collectionId}-${digest.slice(0, 16)}`
  const key = `nftgram/originals/${base}-${slug(fileName)}`
  const publicId = key.replace(/^nftgram\//, '')
  const timestamp = String(Math.floor(Date.now() / 1000))
  const folder = 'nftgram/originals'
  const params = { folder, public_id: publicId.replace(/^originals\//, ''), timestamp }
  // Cloudinary public_id is relative to folder when folder is present.
  const signature = cloudinarySignature(params)
  res.json({ cloudName: process.env.CLOUDINARY_CLOUD_NAME, apiKey: process.env.CLOUDINARY_API_KEY, timestamp, folder, publicId: params.public_id, signature, key, collectionId, contentType, bytes, sha256: digest })
})

app.post('/api/media/upload-complete', processRateLimit('media-complete', 12, 10 * 60_000), requireMediaAuthorization, async (req, res) => {
  if (!cloudinaryEnabled) return res.status(503).json({ error: 'Cloudinary direct uploads are not configured' })
  const collectionId = slug(String(req.body?.collection ?? 'unfiled'))
  const fileName = String(req.body?.fileName ?? '').trim().slice(0, 240)
  const contentType = supportedMediaType(String(req.body?.contentType ?? ''), fileName)
  const digest = String(req.body?.sha256 ?? '').toLowerCase()
  const bytes = Number(req.body?.bytes)
  const urlValue = String(req.body?.cloudinaryUrl ?? '')
  const key = `nftgram/originals/${collectionId}-${digest.slice(0, 16)}-${slug(fileName)}`
  const expectedAssetPrefix = `${collectionId}-${digest.slice(0, 16)}-`
  try {
    const assetUrl = new URL(urlValue)
    const assetPath = decodeURIComponent(assetUrl.pathname)
    const cloudNamePath = `/${process.env.CLOUDINARY_CLOUD_NAME}/`
    // Cloudinary normalizes uploaded file names/extensions differently across
    // resource types. Bind the asset to the server-authorized collection and
    // digest prefix; the full downloaded bytes are checked against SHA-256
    // below before the upload is accepted.
    const pathSegments = assetPath.split('/').filter(Boolean)
    const hasExpectedAssetPrefix = pathSegments.some((segment) => segment.startsWith(expectedAssetPrefix))
    if (!contentType || !/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 25 * 1024 * 1024 || !fileName) {
      return res.status(400).json({ error: 'Upload details are incomplete or exceed the 25 MB limit' })
    }
    if (assetUrl.protocol !== 'https:' || assetUrl.hostname !== 'res.cloudinary.com' || !assetPath.startsWith(cloudNamePath) || !assetPath.includes('/upload/') || !hasExpectedAssetPrefix) {
      return res.status(400).json({ error: 'Cloudinary upload details do not match the authorized file' })
    }
    // The browser's digest is only a claim until we hash the uploaded original
    // ourselves. Restrict the host/path above, disallow redirects, and cap bytes
    // while streaming so this verification cannot be used for SSRF or unbounded
    // downloads.
    const assetResponse = await fetch(assetUrl, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    if (!assetResponse.ok || assetResponse.status >= 300 || !assetResponse.body) {
      return res.status(502).json({ error: 'Could not verify the uploaded artwork bytes. Retry the upload.' })
    }
    const declaredLength = Number(assetResponse.headers.get('content-length') ?? 0)
    if (declaredLength && declaredLength > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'Uploaded media exceeds the 25 MB limit' })
    }
    const reader = assetResponse.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > 25 * 1024 * 1024) {
        await reader.cancel()
        return res.status(413).json({ error: 'Uploaded media exceeds the 25 MB limit' })
      }
      chunks.push(value)
    }
    const uploadedBytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    if (totalBytes !== bytes || sha256(uploadedBytes) !== digest) {
      return res.status(400).json({ error: 'Uploaded media bytes did not match the supplied SHA-256 fingerprint' })
    }
    if (!mediaSignatureMatches(uploadedBytes, contentType)) return res.status(415).json({ error: 'The uploaded bytes do not match the selected media type' })
    const creatorWallet = res.locals.wallet as string | undefined
    if (creatorWallet && databaseAvailable()) {
      await ensureSchema()
      await query(
        `INSERT INTO creator_media_uploads (image_url, collection_id, creator_wallet, object_key, sha256, content_type, bytes, sha256_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, TRUE) ON CONFLICT (image_url) DO UPDATE SET sha256_verified = TRUE`,
        [assetUrl.toString(), collectionId, creatorWallet, key, digest, contentType, bytes],
      )
    }
    res.status(201).json({ sha256: digest, key, original: { r2Url: null, cloudinaryUrl: assetUrl.toString() }, contentType, bytes })
  } catch (error) {
    console.error('Cloudinary upload completion failed:', error instanceof Error ? error.message : error)
    res.status(502).json({ error: 'Could not verify the uploaded artwork. Retry the upload.' })
  }
})

app.post('/api/media/upload', processRateLimit('media-upload', 12, 10 * 60_000), requireMediaAuthorization, upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ error: 'Attach a file using the file form field' })
  if (!cloudinaryEnabled && !r2Enabled) return res.status(503).json({ error: 'No media provider is configured' })

  try {
    const normalizedType = supportedMediaType(file.mimetype, file.originalname)
    if (!normalizedType) {
      return res.status(415).json({ error: 'Supported NFT media: PNG/JPG/WebP/GIF, MP4/WebM video, MP3/WAV/OGG audio, and GLB/GLTF 3D models (25 MB maximum)' })
    }
    if (!mediaSignatureMatches(file.buffer, normalizedType)) return res.status(415).json({ error: 'The uploaded bytes do not match the selected media type' })
    file.mimetype = normalizedType
    const digest = sha256(file.buffer)
    const base = `${slug(req.body?.collection ?? 'unfiled')}-${digest.slice(0, 16)}`
    const key = `nftgram/originals/${base}-${slug(file.originalname)}`
    const [r2Upload, cloudinaryUpload] = await Promise.allSettled([
      putToR2(file, key),
      putToCloudinary(file, base),
    ])
    const r2Url = r2Upload.status === 'fulfilled' ? r2Upload.value : null
    const cloudinaryUrl = cloudinaryUpload.status === 'fulfilled' ? cloudinaryUpload.value : null
    if (!r2Url && !cloudinaryUrl) throw new Error('No media provider accepted the artwork')
    const creatorWallet = res.locals.wallet as string | undefined
    if (creatorWallet && databaseAvailable()) {
      await ensureSchema()
      for (const imageUrl of [r2Url, cloudinaryUrl].filter((value): value is string => Boolean(value))) {
        await query(
        `INSERT INTO creator_media_uploads (image_url, collection_id, creator_wallet, object_key, sha256, content_type, bytes, sha256_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, TRUE) ON CONFLICT (image_url) DO UPDATE SET sha256_verified = TRUE`,
          [imageUrl, slug(req.body?.collection ?? 'unfiled'), creatorWallet, key, digest, file.mimetype, file.size],
        )
      }
    }
    res.status(201).json({ sha256: digest, key, original: { r2Url, cloudinaryUrl }, contentType: file.mimetype, bytes: file.size })
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Media provider upload failed' })
  }
})

app.post('/api/ai/generate-image', requireWallet, async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  const transparent = req.body?.transparent === true
  // Collection Studio appends the assigned traits and art direction to the
  // creator's prompt. FLUX.1 Schnell accepts prompts up to 2,048 characters;
  // the old 1,000-character API limit rejected otherwise valid compositions.
  if (prompt.length < 8 || prompt.length > 2048) return res.status(400).json({ error: 'Artwork prompts must be between 8 and 2,048 characters. Shorten the art direction or trait values and try again.' })
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || (() => {
    try {
      const host = new URL(process.env.CLOUDFLARE_R2_ENDPOINT ?? '').hostname
      return host.match(/^([a-f0-9]{32})\.r2\.cloudflarestorage\.com$/i)?.[1]
    } catch {
      return undefined
    }
  })()
  const apiToken = process.env.CLOUDFLARE_AI_API_TOKEN?.trim()
  if (!accountId || !apiToken) return res.status(503).json({ error: 'AI artwork is not configured yet. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN to the server environment.' })
  // FLUX.1 Schnell currently returns JPEG, including when the caller requests a
  // transparent trait. Keep the subject isolated against a plain background;
  // callers must not assume this response contains an alpha channel.
  const imagePrompt = transparent
    ? `${prompt}\nIsolated subject, centered, on a clean solid white background. No shadows, no text, no border.`
    : prompt
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: imagePrompt, steps: 4 }),
      signal: AbortSignal.timeout(120_000),
    })
    const result = await response.json().catch(() => null) as { result?: { image?: string }; errors?: { message?: string }[]; messages?: { message?: string }[] } | null
    if (!response.ok) return res.status(response.status === 429 ? 429 : 502).json({ error: result?.errors?.[0]?.message || result?.messages?.[0]?.message || 'Cloudflare image generation failed.' })
    const image = result?.result?.image
    if (!image || image.length > 20_000_000) return res.status(502).json({ error: 'Cloudflare returned no usable image.' })
    return res.json({ image: `data:image/jpeg;base64,${image}`, contentType: 'image/jpeg' })
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error && error.name === 'TimeoutError' ? 'Image generation took too long. Try again.' : 'Could not reach the AI image provider.' })
  }
})

app.post('/api/ai/plan-collection-traits', requireWallet, async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  const count = Number(req.body?.count)
  if (prompt.length < 8 || prompt.length > 1500) return res.status(400).json({ error: 'Describe the collection artwork in 8–1,500 characters.' })
  if (!Number.isInteger(count) || count < 1 || count > 8) return res.status(400).json({ error: 'Trait planning supports batches of 1–8 NFTs.' })
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || (() => {
    try {
      const host = new URL(process.env.CLOUDFLARE_R2_ENDPOINT ?? '').hostname
      return host.match(/^([a-f0-9]{32})\.r2\.cloudflarestorage\.com$/i)?.[1]
    } catch {
      return undefined
    }
  })()
  const apiToken = process.env.CLOUDFLARE_AI_API_TOKEN?.trim()
  if (!accountId || !apiToken) return res.status(503).json({ error: 'AI trait planning is not configured on this server.' })
  const instruction = `Plan randomized, visible NFT attributes for an art collection. Collection art direction and creator requirements: ${prompt}. If the creator included a "Required trait categories" list, return exactly those categories in that order and preserve each requested category name exactly. Otherwise choose only useful, visually depictable categories from this consistent title-case vocabulary: Background (scene or setting), Texture (surface finish), Hoodie Color, Skin, Eyes, Mouth, Chest Design, Headwear, Drawstring Color, Body Type, Outfit, Hair, and Pose. Do not use duplicate categories such as Background Color, Clothes, or Body. Return JSON only in this shape: {"categories":[{"name":"Background","options":[{"value":"...","weight":100}]}]}. Each category must have 2 to 5 short distinct values. Use integer weights from 1 to 1000; common values should have higher weights and rare visual variants lower weights. Traits must fit this collection concept and be visible in the artwork. Do not return rarity percentages, names, descriptions, markdown, or explanation.`
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      // Workers AI defaults max_tokens to 256. That truncates a multi-category
      // trait plan before the closing JSON braces, which used to fall through
      // the broad catch below as the unhelpful "Could not plan" error.
      body: JSON.stringify({ messages: [{ role: 'user', content: instruction }], max_tokens: 1200, temperature: 0.2 }),
      signal: AbortSignal.timeout(60_000),
    })
    const result = await response.json().catch(() => null) as { result?: { response?: string }; errors?: { message?: string }[]; messages?: { message?: string }[] } | null
    if (!response.ok) return res.status(response.status === 429 ? 429 : 502).json({ error: result?.errors?.[0]?.message || result?.messages?.[0]?.message || 'AI trait planning failed.' })
    const raw = result?.result?.response?.trim() ?? ''
    const parsed = extractAiJsonObject<{ categories?: unknown }>(raw)
    if (!parsed) {
      console.warn(JSON.stringify({ event: 'ai_trait_plan_invalid_or_missing_json', responseLength: raw.length }))
      return res.status(502).json({ error: 'The AI returned an incomplete trait plan. Try generating traits again.' })
    }
    const categories = Array.isArray(parsed?.categories) ? parsed.categories.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const category = item as { name?: unknown; options?: unknown }
      const name = typeof category.name === 'string' ? stripAiMarkdown(category.name).slice(0, 48) : ''
      const options = Array.isArray(category.options) ? category.options.flatMap((option) => {
        if (!option || typeof option !== 'object') return []
        const entry = option as { value?: unknown; weight?: unknown }
        const value = typeof entry.value === 'string' ? stripAiMarkdown(entry.value).slice(0, 64) : ''
        const weight = Number(entry.weight)
        return value ? [{ value, weight: Number.isFinite(weight) ? Math.min(1000, Math.max(1, Math.round(weight))) : 100 }] : []
      }).slice(0, 8) : []
      return name && options.length >= 2 ? [{ name, options: options.slice(0, 5) }] : []
    }).slice(0, 8) : []
    if (categories.length < 2) return res.status(502).json({ error: 'AI could not produce a usable trait plan. Edit your art direction and try again.' })
    return res.json({ categories })
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error && error.name === 'TimeoutError' ? 'Trait planning took too long. Try again.' : 'Could not plan collection traits.' })
  }
})

app.post('/api/ai/analyze-image', requireWallet, visionUpload.single('image'), async (req, res) => {
  const image = req.file
  if (!image || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimetype) || !mediaSignatureMatches(image.buffer, image.mimetype)) {
    return res.status(400).json({ error: 'Upload a JPEG, PNG, or WebP artwork image (up to 5 MB).' })
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || (() => {
    try {
      const host = new URL(process.env.CLOUDFLARE_R2_ENDPOINT ?? '').hostname
      return host.match(/^([a-f0-9]{32})\.r2\.cloudflarestorage\.com$/i)?.[1]
    } catch {
      return undefined
    }
  })()
  const apiToken = process.env.CLOUDFLARE_AI_API_TOKEN?.trim()
  if (!accountId || !apiToken) return res.status(503).json({ error: 'AI image analysis is not configured on this server.' })
  const imageData = `data:${image.mimetype};base64,${image.buffer.toString('base64')}`
  const prompt = `Inspect this NFT artwork and produce accurate, concise visual attributes as JSON only, in this exact shape: {"attributes":[{"trait_type":"Background","value":"..."}]}. Use consistent title-case trait names selected from Background, Texture, Hoodie Color, Skin, Eyes, Mouth, Chest Design, Headwear, Drawstring Color, Body Type, Outfit, Hair, and Pose. Use Background for the scene/setting, Texture for material finish, Hoodie Color for hoodie color, Outfit for clothing type, Skin for skin appearance, and Body Type for build. Include only traits that are actually visible and distinguishable; omit categories that do not apply or cannot be determined. Use short values, do not infer hidden details, and do not include name, edition, rarity, or commentary.`
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], image: imageData }),
      signal: AbortSignal.timeout(60_000),
    })
    const result = await response.json().catch(() => null) as { result?: { response?: string }; errors?: { message?: string }[]; messages?: { message?: string }[] } | null
    if (!response.ok) return res.status(response.status === 429 ? 429 : 502).json({ error: result?.errors?.[0]?.message || result?.messages?.[0]?.message || 'Cloudflare image analysis failed.' })
    const raw = result?.result?.response?.trim() ?? ''
    const parsed = extractAiJsonObject<{ attributes?: unknown }>(raw)
    const attributes = Array.isArray(parsed?.attributes) ? parsed.attributes.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const attribute = item as { trait_type?: unknown; value?: unknown }
      const trait_type = typeof attribute.trait_type === 'string' ? stripAiMarkdown(attribute.trait_type).slice(0, 48) : ''
      const value = typeof attribute.value === 'string' ? stripAiMarkdown(attribute.value).slice(0, 80) : ''
      return trait_type && value ? [{ trait_type, value }] : []
    }).slice(0, 16) : []
    return res.json({ attributes })
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error && error.name === 'TimeoutError' ? 'Image analysis took too long. Try again.' : 'Could not analyze the artwork image.' })
  }
})

app.post('/api/ai/verify-collection-artwork', requireWallet, visionUpload.single('image'), async (req, res) => {
  const image = req.file
  if (!image || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimetype) || !mediaSignatureMatches(image.buffer, image.mimetype)) {
    return res.status(400).json({ error: 'Upload a JPEG, PNG, or WebP artwork image (up to 5 MB).' })
  }
  let expected: { trait_type: string; value: string }[]
  try {
    const parsed = JSON.parse(String(req.body?.expectedAttributes ?? '[]'))
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16) throw new Error()
    expected = parsed.map((entry) => ({
      trait_type: String(entry?.trait_type ?? '').trim().slice(0, 48),
      value: String(entry?.value ?? '').trim().slice(0, 80),
    }))
    if (expected.some((entry) => !entry.trait_type || !entry.value)) throw new Error()
  } catch {
    return res.status(400).json({ error: 'Provide 1–16 valid assigned traits to check.' })
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || (() => {
    try {
      const host = new URL(process.env.CLOUDFLARE_R2_ENDPOINT ?? '').hostname
      return host.match(/^([a-f0-9]{32})\.r2\.cloudflarestorage\.com$/i)?.[1]
    } catch {
      return undefined
    }
  })()
  const apiToken = process.env.CLOUDFLARE_AI_API_TOKEN?.trim()
  if (!accountId || !apiToken) return res.status(503).json({ error: 'AI artwork review is not configured on this server.' })
  const imageData = `data:${image.mimetype};base64,${image.buffer.toString('base64')}`
  const instruction = `Check whether each assigned NFT trait is visibly depicted in this artwork. Do not assume a trait is present because it was requested. For each item return one status: "visible" only when clearly supported by the image, "missing" when contradicted or not depicted, or "uncertain" when the image is ambiguous. Return JSON only: {"checks":[{"trait_type":"...","expected":"...","status":"visible|missing|uncertain","observed":"short visual evidence or empty string","note":"short explanation or empty string"}],"summary":"one concise sentence"}. Check exactly these assigned traits: ${JSON.stringify(expected)}`
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: instruction }], image: imageData }),
      signal: AbortSignal.timeout(60_000),
    })
    const result = await response.json().catch(() => null) as { result?: { response?: string }; errors?: { message?: string }[]; messages?: { message?: string }[] } | null
    if (!response.ok) return res.status(response.status === 429 ? 429 : 502).json({ error: result?.errors?.[0]?.message || result?.messages?.[0]?.message || 'AI artwork review failed.' })
    const raw = result?.result?.response?.trim() ?? ''
    const parsed = extractAiJsonObject<{ checks?: unknown; summary?: unknown }>(raw)
    const seen = new Set<string>()
    const checks = Array.isArray(parsed?.checks) ? parsed.checks.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const check = item as { trait_type?: unknown; expected?: unknown; status?: unknown; observed?: unknown; note?: unknown }
      const modelTraitType = typeof check.trait_type === 'string' ? stripAiMarkdown(check.trait_type) : ''
      const modelExpected = typeof check.expected === 'string' ? stripAiMarkdown(check.expected) : ''
      const expectedTrait = expected.find((entry) => entry.trait_type.toLowerCase() === modelTraitType.toLowerCase() && entry.value.toLowerCase() === modelExpected.toLowerCase())
      if (!expectedTrait || !['visible', 'missing', 'uncertain'].includes(String(check.status))) return []
      const key = `${expectedTrait.trait_type.toLowerCase()}\u0000${expectedTrait.value.toLowerCase()}`
      if (seen.has(key)) return []
      seen.add(key)
      return [{ trait_type: expectedTrait.trait_type, expected: expectedTrait.value, status: check.status, observed: typeof check.observed === 'string' ? stripAiMarkdown(check.observed).slice(0, 120) : '', note: typeof check.note === 'string' ? stripAiMarkdown(check.note).slice(0, 160) : '' }]
    }) : []
    if (checks.length !== expected.length || seen.size !== expected.length) return res.status(502).json({ error: 'The vision model returned an incomplete trait review. Try again.' })
    return res.json({ checks, summary: typeof parsed?.summary === 'string' ? stripAiMarkdown(parsed.summary).slice(0, 240) : '' })
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error && error.name === 'TimeoutError' ? 'Artwork review took too long. Try again.' : 'Could not review the artwork traits.' })
  }
})

app.post('/api/creator/metadata', requireWallet, async (req, res) => {
  if (!r2) return res.status(503).json({ error: 'Cloudflare R2 is required for public NFT metadata' })
  const wallet = res.locals.wallet as string
  const collectionId = slug(String(req.body?.collection ?? ''))
  const metadata = req.body?.metadata
  const name = String(metadata?.name ?? '').trim().slice(0, 160)
  const description = String(metadata?.description ?? '').trim().slice(0, 2000)
  const image = String(metadata?.image ?? '').trim().slice(0, 1024)
  const animationUrl = String(metadata?.animation_url ?? '').trim().slice(0, 1024)
  const externalUrl = String(metadata?.external_url ?? '').trim().slice(0, 1024)
  const requestedMethod = String(metadata?.creation_method ?? '')
  const creationMethod = ['pixel-studio', 'ai-studio', 'ai-collection-studio', 'collection-settings', 'quick-mint', 'creator-import'].includes(requestedMethod) ? requestedMethod : 'creator-import'
  const editionGroup = String(metadata?.edition_group ?? '').trim()
  const editionIndex = metadata?.edition_index === undefined ? null : Number(metadata.edition_index)
  const attributes = Array.isArray(metadata?.attributes) ? metadata.attributes.slice(0, 100) : []
  if (!name || !image || !/^(https:\/\/|ipfs:\/\/)/i.test(image)) return res.status(400).json({ error: 'Metadata needs a name and a public HTTPS or IPFS image URL' })
  if (animationUrl && !/^https:\/\//i.test(animationUrl)) return res.status(400).json({ error: 'animation_url must use HTTPS' })
  if (externalUrl && !/^https:\/\//i.test(externalUrl)) return res.status(400).json({ error: 'external_url must use HTTPS' })
  if (editionGroup && (!/^[a-f0-9-]{16,64}$/i.test(editionGroup) || !Number.isSafeInteger(editionIndex) || editionIndex! < 0 || editionIndex! > 9999)) return res.status(400).json({ error: 'Invalid unique edition group or index' })
  if (attributes.some((item: any) => !item || typeof item.trait_type !== 'string' || !(typeof item.value === 'string' || typeof item.value === 'number' || typeof item.value === 'boolean'))) {
    return res.status(400).json({ error: 'Each attribute needs a trait_type and a text, number or boolean value' })
  }
  if (attributes.some((item: any) => item.trait_type.length > 64 || (typeof item.value === 'string' && item.value.length > 256)) || new Set(attributes.map((item: any) => item.trait_type.trim().toLowerCase())).size !== attributes.length) {
    return res.status(400).json({ error: 'Trait names must be unique and trait names/values must fit NFT metadata limits' })
  }
  try {
    await ensureSchema()
    const isPersonalMint = collectionId === `personal-${wallet.toLowerCase()}`
    const collection = isPersonalMint ? null : await collectionBySlug(collectionId)
    if (!isPersonalMint && !collection) return res.status(404).json({ error: 'Collection not found' })
    if (!isPersonalMint && collection!.owner_wallet !== wallet) return res.status(403).json({ error: 'Only the collection creator can publish its metadata' })
    const uploadedImage = await query<{ image_url: string; sha256: string; content_type: string; bytes: number; sha256_verified: boolean }[]>(
      'SELECT image_url, sha256, content_type, bytes, sha256_verified FROM creator_media_uploads WHERE image_url = ? AND collection_id = ? AND creator_wallet = ? LIMIT 1',
      [image, collectionId, wallet],
    )
    // A collection cover is uploaded before the collection slug exists, so its
    // media row may be keyed by the symbol. Allow that same verified owner
    // upload to serve as unrevealed placeholder metadata for the collection.
    const uploadedCollectionCover = !isPersonalMint && collection?.cover === image
      ? await query<{ image_url: string; sha256: string; content_type: string; bytes: number; sha256_verified: boolean }[]>(
        'SELECT image_url, sha256, content_type, bytes, sha256_verified FROM creator_media_uploads WHERE image_url = ? AND creator_wallet = ? LIMIT 1',
        [image, wallet],
      )
      : []
    if (!uploadedImage.length && !uploadedCollectionCover.length && !(isPersonalMint && /^(https:\/\/|ipfs:\/\/)/i.test(image))) return res.status(400).json({ error: 'Upload this artwork to StellaNova before publishing metadata' })
    const assetUpload = uploadedImage[0] ?? uploadedCollectionCover[0] ?? null
    let animationUpload: { sha256: string; content_type: string; bytes: number; sha256_verified: boolean } | null = null
    if (animationUrl) {
      const uploadedAnimation = await query<{ image_url: string; sha256: string; content_type: string; bytes: number; sha256_verified: boolean }[]>(
        'SELECT image_url, sha256, content_type, bytes, sha256_verified FROM creator_media_uploads WHERE image_url = ? AND collection_id = ? AND creator_wallet = ? LIMIT 1',
        [animationUrl, collectionId, wallet],
      )
      if (!uploadedAnimation.length) return res.status(400).json({ error: 'Upload this animation, audio or 3D file to StellaNova before publishing metadata' })
      animationUpload = uploadedAnimation[0]
    }
    const provenance = {
      version: 1,
      issuer: 'StellaNova',
      creator_wallet: wallet,
      created_at: new Date().toISOString(),
      creation_method: creationMethod,
      artwork: assetUpload ? { sha256: assetUpload.sha256, content_type: assetUpload.content_type, bytes: assetUpload.bytes, server_verified: assetUpload.sha256_verified } : null,
      animation: animationUpload ? { sha256: animationUpload.sha256, content_type: animationUpload.content_type, bytes: animationUpload.bytes, server_verified: animationUpload.sha256_verified } : null,
      fingerprint_note: assetUpload?.sha256_verified
        ? 'StellaNova independently verified this SHA-256 fingerprint against the uploaded file bytes. This record is not a copyright or authorship determination.'
        : 'This artwork has no server-verified file fingerprint. This record is not a copyright or authorship determination.',
    }
    const editionKey = editionGroup ? `nftgram/metadata/${collectionId}/editions/${editionGroup}/${editionIndex}.json` : null
    // Edition URIs are predictable because the NFT contract constructs them
    // from the stage base URI and token index. Reuse an already-issued record
    // on launch retries so its provenance timestamp and hashes stay stable.
    if (editionKey) {
      const existing = await query<{ metadata_uri: string; object_key: string; sha256: string; provenance: Record<string, unknown> }[]>(
        'SELECT metadata_uri, object_key, sha256, provenance FROM creator_nft_metadata WHERE object_key = ? AND collection_id = ? AND creator_wallet = ? LIMIT 1',
        [editionKey, collectionId, wallet],
      )
      if (existing[0]) return res.status(200).json({ key: existing[0].object_key, url: existing[0].metadata_uri, sha256: existing[0].sha256, provenance: existing[0].provenance })
    }
    const body = Buffer.from(JSON.stringify({ name, description, image, ...(animationUrl ? { animation_url: animationUrl } : {}), attributes, ...(externalUrl ? { external_url: externalUrl } : {}), provenance }, null, 2))
    const digest = sha256(body)
    const key = editionKey ?? `nftgram/metadata/${collectionId}/${digest}.json`
    const url = await putToR2({ buffer: body, mimetype: 'application/json', originalname: `${digest}.json`, size: body.length } as Express.Multer.File, key)
    if (!url) return res.status(503).json({ error: 'R2 has no public metadata URL configured' })
    await query(
      `INSERT INTO creator_nft_metadata (metadata_uri, collection_id, creator_wallet, object_key, sha256, bytes, name, description, image, animation_url, attributes, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb) ON CONFLICT (metadata_uri) DO NOTHING`,
      [url, collectionId, wallet, key, digest, body.length, name, description, image, animationUrl || null, JSON.stringify(attributes), JSON.stringify(provenance)],
    )
    res.status(201).json({ key, url, sha256: digest, provenance })
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Metadata upload failed' })
  }
})

app.post('/api/media/metadata', requireUploadToken, async (req, res) => {
  if (!r2) return res.status(503).json({ error: 'Cloudflare R2 is required for canonical metadata' })
  const tokenId = String(req.body?.tokenId ?? '').replace(/[^0-9]+/g, '')
  if (!tokenId || !req.body?.metadata || typeof req.body.metadata !== 'object') return res.status(400).json({ error: 'tokenId and metadata are required' })
  const body = Buffer.from(JSON.stringify(req.body.metadata, null, 2))
  const key = `nftgram/metadata/${tokenId}.json`
  try {
    const url = await putToR2({ buffer: body, mimetype: 'application/json', originalname: `${tokenId}.json`, size: body.length } as Express.Multer.File, key)
    const digest = sha256(body)
    // Persist the canonical metadata linkage so the read model records the token's
    // metadata URI, media digest and object key (media-architecture boundary).
    if (databaseAvailable()) {
      await ensureSchema()
      await query(
        `INSERT INTO canonical_metadata (token_id, contract_id, object_key, metadata_uri, sha256, content_type, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (contract_id, token_id) DO UPDATE SET object_key=EXCLUDED.object_key, metadata_uri=EXCLUDED.metadata_uri, sha256=EXCLUDED.sha256, content_type=EXCLUDED.content_type, bytes=EXCLUDED.bytes`,
        [tokenId, nftId, key, url ?? '', digest, 'application/json', body.length],
      )
    }
    res.status(201).json({ key, url, sha256: digest })
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Metadata upload failed' })
  }
})

// Keep parser and upload failures bounded and non-reflective. Express's default
// error page can otherwise expose framework details, and multer errors need a
// predictable 4xx instead of a generic 500.
app.use('/api', (error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error)
  const candidate = error && typeof error === 'object' ? error as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown } : {}
  const statusHint = Number(candidate.status ?? candidate.statusCode)
  const isMulterError = error instanceof multer.MulterError
  const status = isMulterError && candidate.code === 'LIMIT_FILE_SIZE' || statusHint === 413
    ? 413
    : isMulterError || statusHint === 400 || statusHint === 415
      ? 400
      : 500
  const requestId = String(res.getHeader('X-Request-Id') ?? '')
  const log = JSON.stringify({ event: 'api_request_rejected', requestId, method: req.method, route: req.route?.path ?? '/api/unmatched', status, errorType: typeof candidate.name === 'string' ? candidate.name.slice(0, 80) : 'Error' })
  if (status >= 500) console.error(log)
  else console.warn(log)
  res.status(status).json({ error: status >= 500 ? 'The request could not be completed.' : status === 413 ? 'The request is too large.' : 'The request is invalid.', requestId })
})

if (!isVercel) startIndexer()

if (isProduction && !isVercel) {
  app.use(express.static(path.join(root, 'dist'), { index: 'index.html' }))
  app.use((_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')))
} else if (!isVercel) {
  const httpServer = createHttpServer(app)
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server: httpServer } } })
  app.use(vite.middlewares)
  httpServer.listen(port, '0.0.0.0', () => console.log(`StellaNova dev server listening on ${port}`))
}

if (isProduction && !isVercel) app.listen(port, '0.0.0.0', () => console.log(`StellaNova production server listening on ${port}`))

export default app
