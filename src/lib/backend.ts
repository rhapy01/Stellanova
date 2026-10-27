import { signWalletChallenge, type StellarWallet } from './stellar'
import { clearPendingReferralCode, pendingReferralCode } from './referrals'
import { trackProductEvent } from './product-analytics'

export type SocialState = {
  subscriptions: string[]
  likes: string[]
  dislikes: string[]
  comments: (SocialComment & { nft_id: string })[]
  notifications: { id: number; kind: string; title: string; body: string; read_at?: string | null; created_at: string }[]
  unreadCount: number
  creatorFollows: string[]
  postLikes: number[]
  postDislikes: number[]
  reposts: number[]
  bookmarks: string[]
}

export type SocialComment = {
  id: number | string
  wallet_address?: string
  body: string
  created_at: string
  parent_id?: number | string | null
}

export type CollectionSocialRecord = {
  collection_id: string
  likes: number
  dislikes: number
  liked: boolean
  disliked: boolean
  comments: SocialComment[]
}

export type NftSocialRecord = { nft_id: string; likes: number; dislikes: number; liked: boolean; disliked: boolean; comments: SocialComment[] }

export type NotificationRecord = {
  id: number
  kind: string
  title: string
  body: string
  action_url?: string
  read_at?: string | null
  created_at: string
}

export type PostRecord = {
  id: number
  author: string
  creator_wallet?: string | null
  author_name: string
  is_me?: boolean
  avatar: string
  media_url: string
  media_type: string
  caption: string
  linked_nft_id: string | null
  post_kind: 'post' | 'drop'
  author_type: 'user' | 'collection'
  collection_id: string | null
  price_xlm: string | null
  created_at: string
  likes: number
  dislikes?: number
  reposts: number
  comments: SocialComment[]
  liked: boolean
  reposted: boolean
  tip_recipient?: string | null
  tips_count?: number
  tips_total_xlm?: string
}

export type CollectionStory = { id: number; mediaUrl: string; mediaType: 'image' | 'video'; caption: string; createdAt: string; expiresAt: string; viewed?: boolean }
export type CollectionStoryGroup = { kind: 'creator' | 'collection'; collectionId: string; creatorWallet?: string; name: string; cover: string; isMine: boolean; stories: CollectionStory[] }

export type OwnedNft = {
  contract_id: string
  token_id: number
  owner_address: string
  ledger: number
}

const walletSessions = new Map<string, string>()
const walletSessionStorageKey = 'nftgram:wallet-sessions'

function persistWalletSessions() {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.setItem(walletSessionStorageKey, JSON.stringify([...walletSessions])) } catch { /* Storage may be unavailable in restricted browser contexts. */ }
}

function restoreWalletSessions() {
  if (typeof window === 'undefined') return
  try {
    const entries: unknown = JSON.parse(window.sessionStorage.getItem(walletSessionStorageKey) ?? '[]')
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && /^G[A-Z2-7]{55}$/.test(entry[0]) && typeof entry[1] === 'string') {
        walletSessions.set(entry[0], entry[1])
      }
    }
  } catch { /* Ignore invalid or unavailable session storage. */ }
}

restoreWalletSessions()

export async function authenticatePrivyWallet(accessToken: string): Promise<{ address: string }> {
  const response = await fetch('/api/auth/privy/session', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ referralCode: pendingReferralCode() }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Email wallet sign-in failed')
  if (typeof result.wallet !== 'string' || typeof result.token !== 'string') throw new Error('The server did not return a verified wallet session')
  walletSessions.set(result.wallet, result.token)
  persistWalletSessions()
  clearPendingReferralCode()
  if (result.referralApplied === true) trackProductEvent('referral_attributed')
  if (result.newAccount === true) trackProductEvent('account_created', { flow: 'privy' })
  return { address: result.wallet }
}

export async function authenticateWallet(wallet: StellarWallet) {
  const challengeResponse = await fetch('/api/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: wallet.address }) })
  const challenge = await challengeResponse.json()
  if (!challengeResponse.ok) throw new Error(challenge.error ?? 'Could not start wallet sign-in')
  const signature = await signWalletChallenge(challenge.message, wallet.address, wallet.networkPassphrase)
  const verifyResponse = await fetch('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: wallet.address, challengeId: challenge.challengeId, signature, referralCode: pendingReferralCode() }) })
  const result = await verifyResponse.json()
  if (!verifyResponse.ok) throw new Error(result.error ?? 'Wallet sign-in failed')
  walletSessions.set(wallet.address, result.token)
  persistWalletSessions()
  clearPendingReferralCode()
  if (result.referralApplied === true) trackProductEvent('referral_attributed')
  if (result.newAccount === true) trackProductEvent('account_created', { flow: 'wallet' })
}

export function authHeaders(address: string): Record<string, string> {
  const token = walletSessions.get(address)
  return token ? { 'x-stellar-address': address, authorization: `Bearer ${token}` } : { 'x-stellar-address': address }
}

export async function clearWalletSession(address: string) {
  const token = walletSessions.get(address)
  walletSessions.delete(address)
  persistWalletSessions()
  if (token) await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined)
}

function headers(address: string) {
  return { 'content-type': 'application/json', ...authHeaders(address) }
}

async function request<T>(url: string, address: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, headers: { ...headers(address), ...(init.headers ?? {}) } })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `StellaNova API request failed (${response.status})`)
  return response.json() as Promise<T>
}

export async function loadSocialState(address: string) {
  return request<SocialState>('/api/social/state', address)
}

export async function fetchNftSocial(ids: string[], address = ''): Promise<NftSocialRecord[]> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return []
  const batches: string[][] = []
  for (let offset = 0; offset < unique.length; offset += 100) batches.push(unique.slice(offset, offset + 100))
  const results = await Promise.all(batches.map(async (batch) => {
    const response = await fetch(`/api/social/nfts?ids=${encodeURIComponent(batch.join(','))}`, { headers: address ? authHeaders(address) : undefined })
    if (!response.ok) throw new Error('Unable to load NFT reactions and comments')
    const data = await response.json() as { social: NftSocialRecord[] }
    return data.social ?? []
  }))
  return results.flat()
}

export async function toggleBookmarkRemote(address: string, nftId: string) {
  return request<{ saved: boolean; nftId: string }>(`/api/social/bookmarks/${encodeURIComponent(nftId)}`, address, { method: 'POST' })
}

export async function toggleSubscriptionRemote(address: string, collectionId: string) {
  return request<{ subscribed: boolean; collectionId: string }>(`/api/social/subscriptions/${encodeURIComponent(collectionId)}`, address, { method: 'POST' })
}

export async function fetchCollectionSocial(collectionIds: string[], address = ''): Promise<CollectionSocialRecord[]> {
  const ids = [...new Set(collectionIds.filter(Boolean))]
  if (!ids.length) return []
  const response = await fetch(`/api/collections/social?ids=${encodeURIComponent(ids.join(','))}`, { headers: address ? authHeaders(address) : undefined })
  if (!response.ok) throw new Error('Unable to load collection reactions')
  const data = await response.json() as { social: CollectionSocialRecord[] }
  return data.social ?? []
}

export async function toggleCollectionLike(address: string, collectionId: string) {
  return request<{ liked: boolean; collectionId: string }>(`/api/collections/${encodeURIComponent(collectionId)}/like`, address, { method: 'POST' })
}

export async function toggleCollectionDislike(address: string, collectionId: string) {
  return request<{ disliked: boolean; collectionId: string }>(`/api/collections/${encodeURIComponent(collectionId)}/dislike`, address, { method: 'POST' })
}

export async function commentOnCollection(address: string, collectionId: string, body: string, parentId?: number | null) {
  return request<{ id: number; collectionId: string; body: string; parentId: number | null; created_at: string }>(`/api/collections/${encodeURIComponent(collectionId)}/comment`, address, { method: 'POST', body: JSON.stringify({ body, parentId }) })
}

export async function toggleLikeRemote(address: string, nftId: string) {
  return request<{ liked: boolean; nftId: string }>(`/api/social/likes/${encodeURIComponent(nftId)}`, address, { method: 'POST' })
}

export async function toggleDislikeRemote(address: string, nftId: string) {
  return request<{ disliked: boolean; nftId: string }>(`/api/social/dislikes/${encodeURIComponent(nftId)}`, address, { method: 'POST' })
}

export async function postCommentRemote(address: string, nftId: string, body: string, parentId?: number | null) {
  return request<{ id: number; nftId: string; body: string; parentId: number | null }>(`/api/social/comments/${encodeURIComponent(nftId)}`, address, { method: 'POST', body: JSON.stringify({ body, parentId }) })
}

export async function markNotificationRead(address: string, id: number) {
  return request<{ read: boolean }>(`/api/notifications/${id}/read`, address, { method: 'POST' })
}

export async function markAllNotificationsRead(address: string) {
  return request<{ read: boolean; updated: number }>('/api/notifications/read-all', address, { method: 'POST' })
}

export async function fetchNotifications(address: string) {
  return request<{ notifications: NotificationRecord[]; unreadCount: number }>('/api/notifications', address)
}

export async function fetchBrowserPushConfig() {
  const response = await fetch('/api/push/config')
  if (!response.ok) throw new Error('Browser alerts are unavailable right now')
  return response.json() as Promise<{ enabled: boolean; publicKey: string | null }>
}

export async function saveBrowserPushSubscription(address: string, subscription: PushSubscriptionJSON) {
  return request<{ subscribed: boolean }>('/api/push/subscription', address, {
    method: 'POST',
    body: JSON.stringify({ subscription }),
  })
}

export async function removeBrowserPushSubscription(address: string, endpoint: string) {
  return request<{ unsubscribed: boolean; removed: boolean }>('/api/push/subscription', address, {
    method: 'DELETE',
    body: JSON.stringify({ endpoint }),
  })
}

export type ReferralSummary = { code: string; referrals: number; activated: number }
export async function fetchReferralSummary(address: string) {
  return request<ReferralSummary>('/api/referrals/me', address)
}

// Register a token → collection mapping so indexed mints fan out “new drop”
// notifications to that collection’s subscribers.
export async function registerTokenCollection(address: string, collectionId: string, tokenId: number | string) {
  return request<{ registered: boolean; collectionId: string; tokenId: string }>(
    `/api/collections/${encodeURIComponent(collectionId)}/tokens/${encodeURIComponent(String(tokenId))}`,
    address,
    { method: 'POST' },
  )
}

export async function getCollectionRegistry(address: string) {
  return request<{ registry: { contract_id: string; token_id: number; collection_id: string }[] }>('/api/collections/registry', address)
}

// ---- Social posts, creator follows, reposts ----

export async function fetchCollectionStories(address: string) {
  return request<{ groups: CollectionStoryGroup[] }>('/api/collection-stories', address)
}

export async function createCollectionStory(address: string, collectionId: string, input: { caption?: string; mediaUrl?: string; mediaType?: 'image' | 'video' }) {
  return request<{ story: CollectionStory }>(`/api/collections/${encodeURIComponent(collectionId)}/stories`, address, { method: 'POST', body: JSON.stringify(input) })
}

export async function createCreatorStory(address: string, input: { caption?: string; mediaUrl?: string; mediaType?: 'image' | 'video' }) {
  return request<{ story: CollectionStory }>('/api/creator-stories', address, { method: 'POST', body: JSON.stringify(input) })
}

export async function markStoryViewed(address: string, kind: 'creator' | 'collection', id: number) {
  return request<{ viewed: boolean }>(`/api/stories/${kind}/${id}/viewed`, address, { method: 'POST', body: '{}' })
}

export async function fetchPosts(address?: string, collectionId?: string, postId?: number, creatorWallet?: string) {
  const headers: Record<string, string> = {}
  if (address) Object.assign(headers, authHeaders(address))
  const params = new URLSearchParams()
  if (collectionId) params.set('collectionId', collectionId)
  if (postId) params.set('postId', String(postId))
  if (creatorWallet) params.set('creatorWallet', creatorWallet)
  const query = params.size ? `?${params.toString()}` : ''
  const response = await fetch(`/api/posts${query}`, { headers })
  if (!response.ok) throw new Error('Unable to load posts')
  const data = (await response.json()) as { posts: PostRecord[] }
  return data.posts ?? []
}

export async function createPost(address: string, input: { caption?: string; mediaUrl?: string; mediaType?: 'image' | 'video'; linkedNftId?: string | null; kind?: 'post' | 'drop'; price?: number | null; collectionId?: string | null }) {
  return request<{ id: number }>('/api/posts', address, { method: 'POST', body: JSON.stringify({ ...input, mediaType: input.mediaType ?? 'image', kind: input.kind ?? 'post' }) })
}

export async function recordPostTip(address: string, postId: number, transactionHash: string) {
  return request<{ postId: number; transactionHash: string; amountXlm: string; duplicate: boolean; tipsCount: number; tipsTotalXlm: string }>(`/api/posts/${postId}/tips`, address, { method: 'POST', body: JSON.stringify({ transactionHash }) })
}

export async function togglePostLike(address: string, postId: number) {
  return request<{ liked: boolean; postId: number }>(`/api/posts/${postId}/like`, address, { method: 'POST' })
}

export async function togglePostDislike(address: string, postId: number) {
  return request<{ disliked: boolean; postId: number }>(`/api/posts/${postId}/dislike`, address, { method: 'POST' })
}

export async function postToPost(address: string, postId: number, body: string, parentId?: number | null) {
  return request<{ id: number; postId: number; body: string; parentId: number | null }>(`/api/posts/${postId}/comment`, address, { method: 'POST', body: JSON.stringify({ body, parentId }) })
}

export async function togglePostRepost(address: string, postId: number) {
  return request<{ reposted: boolean; postId: number }>(`/api/posts/${postId}/repost`, address, { method: 'POST' })
}

export async function toggleCreatorFollow(address: string, creatorId: string) {
  return request<{ followed: boolean; creatorId: string }>(`/api/creators/${encodeURIComponent(creatorId)}/follow`, address, { method: 'POST' })
}

// ---- Wallet accounts, creator onboarding, wallet-owned collections ----
// Mirrors OpenSea: one account per wallet. A wallet becomes a creator by
// creating a collection (permissionless), not by applying.

export type UserAccount = {
  wallet_address: string
  display_name: string
  creator_username: string | null
  avatar: string
  bio: string
  is_creator: boolean
  is_admin: boolean
  is_verified: boolean
}

export type WalletCollection = {
  id: number
  slug: string
  name: string
  symbol: string
  description: string
  cover: string
  contract_id?: string | null
  is_verified?: boolean
  verification_status?: string
  owner_name?: string
  total_supply?: number | null
  website_url?: string | null
  social_links?: Record<string, string>
}

export type PublicCollection = {
  id: number
  slug: string
  name: string
  symbol: string
  description: string
  cover: string
  owner_wallet: string
  is_verified: boolean
  verification_status: string
  nft_count: number
  contract_id: string | null
  total_supply: number | null
  website_url: string | null
  social_links: Record<string, string>
  minting_now?: boolean
  revealed: boolean
}

export type AnalyticsSnapshot = {
  generatedAt: string
  network: string
  summary: { collections: number; minted: number; holders: number; listings: number; sales: number; primary_volume_xlm: string; secondary_volume_xlm: string; volume_xlm: string }
  daily: { day: string; mints: number; primary_volume_xlm: string; secondary_volume_xlm: string; volume_xlm: string }[]
  topCollections: { collection_id: string; name: string; cover: string; minted: number }[]
}

type SocialEntityKind = 'post' | 'nft' | 'collection' | 'creator'

export function createTrackedShareUrl(path: string, _entityKind: SocialEntityKind, _entityId: string) {
  return new URL(path, window.location.origin).toString()
}

export async function fetchAnalyticsOverview(): Promise<AnalyticsSnapshot> {
  const response = await fetch('/api/analytics/overview')
  const data = await response.json() as AnalyticsSnapshot & { error?: string }
  if (!response.ok) throw new Error(data.error || 'Analytics are temporarily unavailable')
  return data
}

export type OpsHealth = {
  status: 'ready' | 'degraded'
  checkedAt: string
  components: { database: { ok: boolean }; sorobanRpc: { ok: boolean; latestLedger?: number }; indexer: { ok: boolean; indexedThrough: number | null; lagLedgers: number | null; hasRecentProcessError: boolean } }
  alert: { sent?: boolean; emailConfigured: boolean; webhookConfigured: boolean; lastSentAt: string | null; lastResult: string }
}
export type OpsReconciliation = {
  checkedAt: string
  summary: { confirmed_mints: number; missing_owner_projection: number; missing_metadata_projection: number; latest_ledger: number | null }
  recentTransactions: { tx_hash: string; contract_id: string; token_id: number; ledger: number; owner_projected: boolean; metadata_projected: boolean }[]
  recoveryRuns: { checked: number; mismatches: number; repaired: number; failed: number; metadata_repaired: number; metadata_failed: number; latest_ledger: number | null; created_at: string }[]
}
export async function fetchOpsHealth(address: string): Promise<OpsHealth> {
  const response = await fetch('/api/admin/ops/health', { headers: authHeaders(address), cache: 'no-store' })
  const data = await response.json() as OpsHealth & { error?: string }
  if (!response.ok && response.status !== 503) throw new Error(data.error ?? 'Unable to load operations health')
  return data
}
export async function fetchOpsReconciliation(address: string) {
  return request<OpsReconciliation>('/api/admin/ops/reconciliation', address, { cache: 'no-store' })
}
export async function runOpsReconciliation(address: string) {
  return request<{ checked: number; mismatches: number; repaired: number; failed: number; latestLedger: number | null; metadataRepaired?: number; metadataFailed?: number; completedAt: string }>('/api/admin/ops/reconciliation/recover', address, { method: 'POST', body: JSON.stringify({ limit: 50 }) })
}

export type PublicCreatorProfile = {
  wallet_address: string
  display_name: string
  creator_username: string | null
  avatar: string
  bio: string
  is_creator: boolean
  is_verified: boolean
  collection_count: number
  collector_count: number
}

export async function fetchPublicCreatorProfile(identifier: string): Promise<PublicCreatorProfile> {
  const response = await fetch(`/api/creators/profile/${encodeURIComponent(identifier)}`, { cache: 'no-store' })
  const data = await response.json() as { profile?: PublicCreatorProfile; error?: string }
  if (!response.ok || !data.profile) throw new Error(data.error ?? 'Creator profile not found')
  return data.profile
}

export async function fetchCreatorProfiles(wallets: string[]): Promise<PublicCreatorProfile[]> {
  const addresses = [...new Set(wallets.filter((wallet) => /^G[A-Z2-7]{55}$/.test(wallet)))].slice(0, 100)
  if (!addresses.length) return []
  const response = await fetch(`/api/creators/profiles?wallets=${encodeURIComponent(addresses.join(','))}`)
  if (!response.ok) throw new Error('Unable to load creator profiles')
  const data = await response.json() as { profiles: PublicCreatorProfile[] }
  return data.profiles ?? []
}

export async function fetchPublicCollections() {
  const response = await fetch('/api/collections')
  if (!response.ok) throw new Error('Unable to load collections')
  const data = await response.json() as { collections: PublicCollection[] }
  return data.collections ?? []
}

export type CollectionMintHistoryEntry = {
  wallet: string
  total_minted: number
  last_ledger: number
  stages: { stage_name: string; stage_minted: number }[]
}

export type PublicFeedbackEntry = {
  id: number
  category: 'idea' | 'problem' | 'praise'
  title: string
  body: string
  status: 'new' | 'planned' | 'in_progress' | 'done'
  created_at: string
}

export async function fetchPublicFeedback(): Promise<PublicFeedbackEntry[]> {
  const response = await fetch('/api/feedback')
  const data = await response.json().catch(() => ({})) as { entries?: PublicFeedbackEntry[]; error?: string }
  if (!response.ok) throw new Error(data.error || 'Feedback is temporarily unavailable')
  return data.entries ?? []
}

export async function submitPublicFeedback(input: { category: PublicFeedbackEntry['category']; title: string; body: string }): Promise<PublicFeedbackEntry> {
  const response = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const data = await response.json().catch(() => ({})) as { entry?: PublicFeedbackEntry; error?: string }
  if (!response.ok || !data.entry) throw new Error(data.error || 'Feedback could not be submitted')
  return data.entry
}

export type CreatorServiceListing = {
  id: number; creator_wallet: string; creator_name: string; title: string; category: 'commission' | 'creative_service';
  description: string; image_url: string | null; pricing_type: 'quote' | 'starting_at' | 'fixed'; price_xlm: string | null;
  availability: string; delivery_details: string | null; status: 'published' | 'paused' | 'sold'; created_at: string
}
export type CreatorServiceRequest = {
  id: number; listing_id: number; buyer_wallet: string; creator_wallet: string; brief: string; delivery_address: string | null;
  status: 'requested' | 'accepted' | 'declined' | 'paid' | 'in_progress' | 'shipped' | 'delivered' | 'completed';
  agreed_amount_xlm: string | null; transaction_hash: string | null; creator_note: string | null; created_at: string;
  title: string; category: 'commission' | 'creative_service'; pricing_type: CreatorServiceListing['pricing_type']; listing_price_xlm: string | null
}
export type CreatorExhibition = {
  id: number; organizer_wallet: string; organizer_name: string; title: string; description: string; venue: string; street_address: string;
  city: string; region: string; country: string; starts_at: string; ends_at: string; website_url: string | null; ticket_url: string | null;
  image_url: string | null; status: 'published' | 'cancelled'; created_at: string
}

export async function fetchCreatorServices(category?: string) {
  const query = category ? `?category=${encodeURIComponent(category)}` : ''
  const response = await fetch(`/api/creator-services${query}`)
  const data = await response.json().catch(() => ({})) as { items?: CreatorServiceListing[]; error?: string }
  if (!response.ok) throw new Error(data.error || 'Creator services are temporarily unavailable')
  return data.items ?? []
}
export async function fetchMyCreatorServices(address:string) { return (await request<{items:CreatorServiceListing[]}>('/api/creator-services/mine',address)).items }
export async function createCreatorService(address: string, input: { title: string; category: 'commission' | 'creative_service'; description: string; imageUrl?: string; pricingType: 'quote' | 'starting_at' | 'fixed'; priceXlm?: string; availability: string; deliveryDetails: string }) {
  return request<{ id: number }>('/api/creator-services', address, { method: 'POST', body: JSON.stringify(input) })
}
export async function updateCreatorService(address: string, id: number, status: 'published' | 'paused') {
  return request<{ ok: boolean }>(`/api/creator-services/${id}`, address, { method: 'PATCH', body: JSON.stringify({ status }) })
}
export async function fetchCreatorServiceRequests(address: string) {
  return (await request<{ items: CreatorServiceRequest[] }>('/api/creator-service-requests', address)).items
}
export async function createCreatorServiceRequest(address: string, listingId: number, brief: string, deliveryAddress?: string) {
  return request<{ id: number }>('/api/creator-service-requests', address, { method: 'POST', body: JSON.stringify({ listingId, brief, deliveryAddress }) })
}
export async function respondCreatorServiceRequest(address: string, id: number, input: { action: string; amountXlm?: string; note?: string }) {
  return request<{ ok: boolean }>(`/api/creator-service-requests/${id}`, address, { method: 'PATCH', body: JSON.stringify(input) })
}
export async function recordCreatorServicePayment(address: string, id: number, transactionHash: string) {
  return request<{ ok: boolean; transactionHash: string }>(`/api/creator-service-requests/${id}/payment`, address, { method: 'POST', body: JSON.stringify({ transactionHash }) })
}
export async function fetchExhibitions(scope: 'upcoming' | 'past' = 'upcoming') {
  const response = await fetch(`/api/exhibitions?scope=${scope}`)
  const data = await response.json().catch(() => ({})) as { items?: CreatorExhibition[]; error?: string }
  if (!response.ok) throw new Error(data.error || 'Exhibitions are temporarily unavailable')
  return data.items ?? []
}
export async function createExhibition(address: string, input: Record<string, unknown>) {
  return request<{ id: number }>('/api/exhibitions', address, { method: 'POST', body: JSON.stringify(input) })
}
export async function updateExhibition(address: string, id: number, status: 'published' | 'cancelled') {
  return request<{ ok: boolean }>(`/api/exhibitions/${id}`, address, { method: 'PATCH', body: JSON.stringify({ status }) })
}
export type PhysicalArtListing = { id:number; creator_wallet:string; creator_name:string; title:string; description:string; image_url:string; price_xlm:string; dimensions:string; medium:string; delivery_details:string; status:'published'|'paused'|'sold'; created_at:string }
export type PhysicalArtOrder = { id:number; listing_id:number; buyer_wallet:string; seller_wallet:string; delivery_address:string; status:'pending'|'paid'|'shipped'|'delivered'|'completed'|'cancelled'; transaction_hash:string|null; tracking_note:string|null; created_at:string; title:string; price_xlm:string; image_url:string }
export async function fetchPhysicalArt() {
  const response = await fetch('/api/physical-art')
  const data = await response.json().catch(() => ({})) as { items?: PhysicalArtListing[]; error?: string }
  if (!response.ok) throw new Error(data.error || 'Physical art is temporarily unavailable')
  return data.items ?? []
}
export async function fetchMyPhysicalArt(address:string) { return (await request<{items:PhysicalArtListing[]}>('/api/physical-art/mine',address)).items }
export async function createPhysicalArt(address:string,input:Record<string,unknown>) { return request<{id:number}>('/api/physical-art',address,{method:'POST',body:JSON.stringify(input)}) }
export async function updatePhysicalArt(address:string,id:number,status:'published'|'paused') { return request<{ok:boolean}>(`/api/physical-art/${id}`,address,{method:'PATCH',body:JSON.stringify({status})}) }
export async function fetchPhysicalArtOrders(address:string) { return (await request<{items:PhysicalArtOrder[]}>('/api/physical-art/orders',address)).items }
export async function createPhysicalArtOrder(address:string,id:number,deliveryAddress:string) { return request<{id:number}>(`/api/physical-art/${id}/orders`,address,{method:'POST',body:JSON.stringify({deliveryAddress})}) }
export async function recordPhysicalArtPayment(address:string,id:number,transactionHash:string) { return request<{ok:boolean}>(`/api/physical-art/orders/${id}/payment`,address,{method:'POST',body:JSON.stringify({transactionHash})}) }
export async function updatePhysicalArtOrder(address:string,id:number,action:string,note?:string) { return request<{ok:boolean}>(`/api/physical-art/orders/${id}`,address,{method:'PATCH',body:JSON.stringify({action,note})}) }

export type NftChainActivityEntry = {
  kind: 'mint' | 'transfer' | 'sale'
  tx_hash: string
  ledger: number
  from: string | null
  to: string | null
  amount_xlm: string | null
}

export type NftProvenanceRecord = {
  contract_id: string
  token_id: number
  creator_wallet: string | null
  minter: string
  mint_tx_hash: string
  mint_ledger: number
  metadata_uri: string | null
  metadata_sha256: string | null
  metadata_created_at: string | null
  asset_sha256: string | null
  asset_content_type: string | null
  asset_bytes: number | null
  asset_sha256_verified: boolean
  animation_sha256: string | null
  animation_content_type: string | null
  animation_bytes: number | null
  animation_sha256_verified: boolean
  version: number
  creation_method: string | null
}

export async function fetchNftProvenance(contractId: string, tokenId: number): Promise<NftProvenanceRecord> {
  const response = await fetch(`/api/nfts/${encodeURIComponent(contractId)}/${tokenId}/provenance`)
  const data = await response.json() as NftProvenanceRecord & { error?: string }
  if (!response.ok) throw new Error(data.error || 'Unable to load NFT provenance')
  return data
}

export async function fetchNftChainActivity(contractId: string, tokenId: number): Promise<NftChainActivityEntry[]> {
  const response = await fetch(`/api/nfts/${encodeURIComponent(contractId)}/${tokenId}/activity`)
  const data = await response.json() as { activity?: NftChainActivityEntry[]; error?: string }
  if (!response.ok) throw new Error(data.error || 'Unable to load NFT chain activity')
  return data.activity ?? []
}

export async function fetchCollectionMintHistory(slug: string): Promise<CollectionMintHistoryEntry[]> {
  const response = await fetch(`/api/collections/${encodeURIComponent(slug)}/mint-history`)
  if (!response.ok) throw new Error('Unable to load collection mint history')
  const data = await response.json() as { wallets: CollectionMintHistoryEntry[] }
  return data.wallets ?? []
}

export type ReviewCollection = WalletCollection & { owner_wallet: string; verified_by: string | null; verified_at: string | null; created_at: string }

export async function fetchReviewCollections(address: string, status = 'pending') {
  return request<{ collections: ReviewCollection[] }>(`/api/admin/collections/review?status=${encodeURIComponent(status)}`, address)
}

export async function verifyCollection(address: string, id: number, action: 'approve' | 'reject') {
  return request<{ ok: boolean; id: number; isVerified: boolean; verificationStatus: string }>(`/api/admin/collections/${id}/verify`, address, { method: 'POST', body: JSON.stringify({ action }) })
}

export async function fetchAccount(address: string) {
  const data = await request<{ account: UserAccount | null; isCreator: boolean; isAdmin: boolean; collections: WalletCollection[] }>('/api/account', address)
  return data
}

export async function updateProfile(address: string, input: { displayName?: string; avatar?: string; bio?: string; creatorUsername?: string }) {
  return request<{ ok: boolean }>('/api/account/profile', address, { method: 'POST', body: JSON.stringify(input) })
}

export async function registerNftContract(address: string, contractId: string) {
  return request<{ registered: boolean; contractId: string; network: string }>('/api/nft/contracts/register', address, { method: 'POST', body: JSON.stringify({ contractId }) })
}

export async function createCollection(address: string, input: { name: string; symbol: string; description?: string; cover?: string; totalSupply: number | null; contractId: string }) {
  return request<{ id: number; slug: string; contractId: string; totalSupply: number | null; isCreator: boolean }>('/api/account/collections', address, { method: 'POST', body: JSON.stringify(input) })
}

export async function updateCollectionProfile(address: string, slug: string, input: { websiteUrl: string; socialLinks: Record<string, string>; cover?: string }) {
  return request<{ updated: boolean; websiteUrl: string | null; socialLinks: Record<string, string>; cover: string }>(`/api/collections/${encodeURIComponent(slug)}/profile`, address, { method: 'PUT', body: JSON.stringify(input) })
}

export class OwnershipSourceUnavailable extends Error {
  constructor() {
    super('Indexed ownership data is not available')
    this.name = 'OwnershipSourceUnavailable'
  }
}

/**
 * Fetch the on-chain NFTs owned by a wallet from the indexed backend.
 *
 * Returns an empty list when the backend is reachable and the wallet owns
 * nothing. Throws {@link OwnershipSourceUnavailable} when the indexed backend is
 * unreachable or not configured so callers can distinguish "authoritatively empty"
 * from "we cannot tell" and keep ownership validation strict.
 */
export async function fetchOwnedNfts(address: string): Promise<OwnedNft[]> {
  const response = await fetch(`/api/marketplace/ownership/${encodeURIComponent(address)}`)
  if (!response.ok) {
    if (response.status === 503) throw new OwnershipSourceUnavailable()
    throw new Error(`Ownership query failed (${response.status})`)
  }
  const data = (await response.json()) as { owned: OwnedNft[] }
  return data.owned ?? []
}

// ---- Minted NFTS ----

export type MintedNft = {
  contract_id: string
  token_id: number
  minter: string
  owner_address?: string | null
  owner_name?: string | null
  collection_id: string | null
  title: string
  image: string
  animation_url?: string | null
  attributes?: { trait_type: string; value: string | number | boolean }[]
  rarity_rank?: number | null
  rarity_score?: string | number | null
  price_xlm: string | null
  metadata_uri: string
  created_at: string
}

export type MarketplaceListing = {
  listing_id: number
  contract_id?: string
  seller: string
  nft_contract: string
  token_id: number
  payment_token: string
  price: string
  expires_at: number
  ledger: number
}

export type MarketplaceAuction = {
  auction_id: number
  seller: string
  nft_contract: string
  token_id: number
  payment_token: string
  reserve_price: string
  min_increment: string
  highest_bid: string
  highest_bidder: string | null
  starts_at: number
  ends_at: number
  active: boolean
  ledger: number
}

export type MarketplaceCollectionOffer = {
  offer_id: number
  contract_id: string
  buyer: string
  nft_contract: string
  collection_scope: string
  payment_token: string
  amount: string
  expires_at: number
  ledger: number
}

export type MarketplaceTraitOffer = MarketplaceCollectionOffer & { trait_type: string; trait_value: string }

export async function fetchActiveMarketplaceCollectionOffers(): Promise<MarketplaceCollectionOffer[]> {
  const response = await fetch('/api/marketplace/status')
  if (!response.ok) throw new Error(`Marketplace collection offers query failed (${response.status})`)
  const data = await response.json() as { collectionOffers?: MarketplaceCollectionOffer[] }
  return data.collectionOffers ?? []
}

export async function fetchActiveMarketplaceTraitOffers(): Promise<MarketplaceTraitOffer[]> {
  const response = await fetch('/api/marketplace/status')
  if (!response.ok) throw new Error(`Marketplace trait offers query failed (${response.status})`)
  const data = await response.json() as { traitOffers?: MarketplaceTraitOffer[] }
  return data.traitOffers ?? []
}

export async function fetchActiveMarketplaceListings(): Promise<MarketplaceListing[]> {
  const response = await fetch('/api/marketplace/status')
  if (!response.ok) throw new Error(`Marketplace listings query failed (${response.status})`)
  const data = await response.json() as { listings?: MarketplaceListing[] }
  return data.listings ?? []
}

export async function fetchActiveMarketplaceAuctions(): Promise<MarketplaceAuction[]> {
  const response = await fetch('/api/marketplace/status')
  if (!response.ok) throw new Error(`Marketplace auctions query failed (${response.status})`)
  const data = await response.json() as { auctions?: MarketplaceAuction[] }
  return data.auctions ?? []
}

export type MarketplaceOffer = {
  offer_id: number
  contract_id?: string
  nft_contract: string
  token_id: number
  buyer?: string
  amount: string
  payment_token?: string
  expires_at: number
  ledger: number
  response_status?: 'countered' | 'counter_accepted' | 'counter_rejected' | null
  counter_amount?: string | null
  nft_title?: string | null
  nft_image?: string | null
  nft_collection_id?: string | null
}

export type MarketplaceState = {
  wallet: string
  listings: MarketplaceListing[]
  offers: MarketplaceOffer[]
  incomingOffers: MarketplaceOffer[]
  ownedTokens: { contract_id: string; token_id: number }[]
}

/**
 * Fetch a wallet's live listings, outgoing offers, and incoming offers so it can
 * cancel listings, cancel offers, and accept offers on tokens it owns.
 */
export async function fetchMarketplaceState(address: string): Promise<MarketplaceState> {
  const response = await fetch(`/api/marketplace/state/${encodeURIComponent(address)}`)
  if (!response.ok) throw new Error(`Marketplace state query failed (${response.status})`)
  return response.json() as Promise<MarketplaceState>
}

export async function respondToMarketplaceOffer(address: string, offerId: number, action: 'counter' | 'counter-accept' | 'counter-reject', amount?: string, contractId?: string) {
  const route = action === 'counter' ? 'counter' : 'counter-response'
  const body = action === 'counter' ? { amount, contractId } : { action: action === 'counter-accept' ? 'accept' : 'reject', contractId }
  return request<{ status: string; counterAmount?: string | null }>(`/api/marketplace/offers/${offerId}/${route}`, address, { method: 'POST', body: JSON.stringify(body) })
}

// ---- Collection mint timeline (drop stages + allowlists) ----
// Mirrors the OpenSea/SeaDrop model: ordered mint stages with their own window,
// price and per-wallet limit; presale stages gated by a per-stage allowlist.

export type MintStage = {
  id: number
  kind: 'team' | 'guaranteed' | 'fcfs' | 'public'
  name: string
  start_time: string | null
  end_time: string | null
  price_xlm: string | null
  per_wallet_limit: number
  max_supply: number | null
  sort_order: number
  metadata_uri: string
  metadata_uris: string[]
  edition_count: number
  metadata_name: string
  metadata_image: string
}

export type MintWhitelistEntry = {
  stage_id: number
  wallet: string
  custom_limit: number | null
  custom_price: string | null
}

export type CollectionDrop = {
  collection: { id: number; slug: string; name: string; symbol: string; contractId: string | null; revealed: boolean; placeholderMetadataUri: string | null }
  stages: MintStage[]
  whitelist: MintWhitelistEntry[]
  whitelistCounts: Record<number, number>
  isOwner: boolean
}

export type CollectionDropDraftArtwork = { id: string; name: string; image: string; animation_url?: string; description: string; attributes?: { trait_type: string; value: string | number | boolean }[]; rarityScore?: number }
export type CollectionDropDraftStage = {
  key: string; kind: MintStage['kind']; name: string; durationHours: number; price: string; editionGroup?: string;
  perWalletLimit: number; maxSupply: number | null; artworkIds: string[]; metadataUris?: string[]
}
export type CollectionDropDraft = {
  startTime: string
  artwork: CollectionDropDraftArtwork[]
  stages: CollectionDropDraftStage[]
  allowlists: Record<string, { wallet: string; customLimit: number | null; customPrice: string | null }[]>
  rarityMix?: { high: number; medium: number; common: number }
  raritySeed?: number
  masterArtworkExpansion?: boolean
  launched?: boolean
  stageIds?: Record<string, number>
  stageContractId?: string
}

export type CreatorArchiveCollection = {
  collection_slug: string
  name: string
  symbol: string
  total_supply: number | null
  artwork_count: number
  archived_at: string
}

export async function fetchCreatorArchive(address: string): Promise<CreatorArchiveCollection[]> {
  const result = await request<{ items: CreatorArchiveCollection[] }>('/api/creator/archive', address)
  return result.items ?? []
}

export async function archiveCreatorCollection(address: string, collectionSlug: string, artworkCount: number): Promise<CreatorArchiveCollection> {
  const result = await request<{ item: CreatorArchiveCollection }>('/api/creator/archive', address, { method: 'POST', body: JSON.stringify({ collectionSlug, artworkCount }) })
  return result.item
}

export async function fetchCollectionDropDraft(address: string, slug: string): Promise<CollectionDropDraft> {
  const response = await fetch(`/api/collections/${encodeURIComponent(slug)}/drop/setup`, { headers: authHeaders(address) })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Unable to load collection setup')
  const result = await response.json() as { setup: Partial<CollectionDropDraft> }
  return { startTime: result.setup.startTime ?? '', artwork: result.setup.artwork ?? [], stages: result.setup.stages ?? [], allowlists: result.setup.allowlists ?? {}, rarityMix: result.setup.rarityMix ?? { high: 10, medium: 30, common: 60 }, raritySeed: result.setup.raritySeed, masterArtworkExpansion: result.setup.masterArtworkExpansion ?? false, launched: result.setup.launched ?? false, stageIds: result.setup.stageIds ?? {} }
}

export async function saveCollectionDropDraft(address: string, slug: string, setup: CollectionDropDraft) {
  return request<{ saved: boolean; setup: CollectionDropDraft }>(`/api/collections/${encodeURIComponent(slug)}/drop/setup`, address, { method: 'PUT', body: JSON.stringify({ setup }) })
}

export async function clearCollectionDropDraft(address: string, slug: string, removedStageIds: number[]) {
  return request<{ cleared: boolean }>(`/api/collections/${encodeURIComponent(slug)}/drop/setup`, address, { method: 'DELETE', body: JSON.stringify({ removedStageIds }) })
}

export async function fetchCollectionDropResetPlan(address: string, slug: string) {
  return request<{ stageIds: number[]; candidateContractIds: string[] }>(`/api/collections/${encodeURIComponent(slug)}/drop/setup/reset-plan`, address)
}

export type MintEligibilityStage = {
  stageId: number
  kind: string
  name: string
  startTime: string | null
  endTime: string | null
  price: string | null
  perWalletLimit: number
  walletMinted: number
  stageMinted: number
  remainingForWallet: number
  remainingSupply: number | null
  maxSupply: number | null
  onAllowlist: boolean
  customPrice: string | null
  status: 'public' | 'restricted' | 'guaranteed' | 'fcfs' | 'team' | 'not-whitelisted'
  active: boolean
  metadataUri: string
  metadataUris: string[]
  metadataName: string
  metadataImage: string
}

export type MintEligibility = {
  collection: { slug: string; name: string; contractId: string | null; revealed: boolean; placeholderMetadataUri: string | null }
  wallet: string | null
  now: string
  stages: MintEligibilityStage[]
}

export async function fetchCollectionDrop(slug: string, address?: string): Promise<CollectionDrop> {
  const headers: Record<string, string> = {}
  if (address) Object.assign(headers, authHeaders(address))
  const response = await fetch(`/api/collections/${encodeURIComponent(slug)}/drop`, { headers })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Unable to load collection drop')
  return response.json() as Promise<CollectionDrop>
}

export async function createMintStage(address: string, slug: string, input: { kind: MintStage['kind']; name?: string; startTime?: string | null; endTime?: string | null; price?: number | null; perWalletLimit?: number; maxSupply?: number | null; metadataUris: string[]; draft?: boolean }) {
  return request<{ id: number; slug: string; kind: string; sortOrder: number; metadataUri: string; metadataUris: string[] }>(`/api/collections/${encodeURIComponent(slug)}/drop/stages`, address, { method: 'POST', body: JSON.stringify(input) })
}

export async function updateMintStageMetadata(address: string, slug: string, stageId: number, metadataUris: string[]) {
  return request<{ id: number; metadataUri: string; metadataUris: string[] }>(`/api/collections/${encodeURIComponent(slug)}/drop/stages/${stageId}/metadata`, address, { method: 'PUT', body: JSON.stringify({ metadataUris }) })
}

export async function publishMintStage(address: string, slug: string, stageId: number) {
  return request<{ published: boolean; id: number }>(`/api/collections/${encodeURIComponent(slug)}/drop/stages/${stageId}/publish`, address, { method: 'POST', body: '{}' })
}

export async function updateCollectionReveal(address: string, slug: string, input: { revealed: boolean; placeholderUri?: string }) {
  return request<{ revealed: boolean; placeholderMetadataUri: string | null }>(`/api/collections/${encodeURIComponent(slug)}/reveal`, address, { method: 'POST', body: JSON.stringify(input) })
}

export async function fetchCollectionRevealMetadata(address: string, slug: string) {
  const response = await fetch(`/api/collections/${encodeURIComponent(slug)}/reveal/metadata`, { headers: authHeaders(address) })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Unable to load token metadata for reveal')
  return response.json() as Promise<{ tokens: { token_id: number; metadata_uri: string }[] }>
}

export async function deleteMintStage(address: string, slug: string, stageId: number) {
  return request<{ deleted: boolean; id: number }>(`/api/collections/${encodeURIComponent(slug)}/drop/stages/${stageId}`, address, { method: 'DELETE' })
}

export async function addWhitelistEntries(address: string, slug: string, stageId: number, entries: { wallet: string; customLimit?: number | null; customPrice?: number | null }[]) {
  return request<{ added: number; stageId: number; slug: string }>(`/api/collections/${encodeURIComponent(slug)}/drop/whitelist`, address, { method: 'POST', body: JSON.stringify({ stageId, entries }) })
}

export async function removeWhitelistEntry(address: string, slug: string, stageId: number, wallet: string) {
  return request<{ removed: boolean; stageId: number; wallet: string }>(`/api/collections/${encodeURIComponent(slug)}/drop/whitelist/${stageId}/${encodeURIComponent(wallet)}`, address, { method: 'DELETE' })
}

export async function fetchMintEligibility(slug: string, wallet?: string): Promise<MintEligibility> {
  const query = wallet ? `?wallet=${encodeURIComponent(wallet)}` : ''
  const response = await fetch(`/api/collections/${encodeURIComponent(slug)}/drop/eligibility${query}`)
  if (!response.ok) throw new Error('Unable to load mint eligibility')
  return response.json() as Promise<MintEligibility>
}

/**
 * Records a freshly minted token in the read model and maps it into a collection
 * so the indexer can fan out drop alerts and the token can become listable/tradeable.
 */
export type MintRecordInput = { tokenId: number; collectionId: string; contractId?: string; title?: string; image?: string; metadataUri: string; txHash: string; stageId?: number; price?: number | null }
type PendingMintRecord = { address: string; input: MintRecordInput }
const pendingMintKey = 'nftgram:pending-mint-records'

function pendingMintRecords(): PendingMintRecord[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(pendingMintKey) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function writePendingMintRecords(records: PendingMintRecord[]) {
  try { window.localStorage.setItem(pendingMintKey, JSON.stringify(records)) } catch { /* storage can be disabled */ }
}

export function getPendingMint(address: string, collectionId: string, stageId?: number): MintRecordInput | null {
  const match = pendingMintRecords().find(({ address: owner, input }) => owner === address && input.collectionId === collectionId && input.stageId === stageId)
  return match?.input ?? null
}

/** Confirmed mints waiting for read-model indexing, scoped to this wallet. */
export function getPendingMintRecords(address: string): MintRecordInput[] {
  return pendingMintRecords().filter((item) => item.address.toLowerCase() === address.toLowerCase()).map((item) => item.input)
}

export async function flushPendingMints(address: string) {
  const pending = pendingMintRecords().filter((item) => item.address === address)
  let indexed = 0
  for (const item of pending) {
    try { await recordMintedNft(address, item.input); indexed += 1 } catch { /* retained for a later retry */ }
  }
  return indexed
}

export async function recordMintedNft(address: string, input: MintRecordInput) {
  const queued = pendingMintRecords()
  if (!queued.some((item) => item.address === address && item.input.collectionId === input.collectionId && item.input.tokenId === input.tokenId)) {
    queued.push({ address, input })
    writePendingMintRecords(queued)
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch('/api/nfts/mint', {
      method: 'POST', headers: headers(address),
      body: JSON.stringify({ ...input, price: input.price === undefined ? null : input.price }),
    })
    if (response.ok) {
      const result = await response.json() as { minted: boolean; contractId: string; tokenId: number; collectionId: string | null; title: string }
      writePendingMintRecords(pendingMintRecords().filter((item) => !(item.address === address && item.input.collectionId === input.collectionId && item.input.tokenId === input.tokenId)))
      window.dispatchEvent(new CustomEvent('nftgram:mint-recorded', { detail: { collectionId: input.collectionId, tokenId: input.tokenId } }))
      return result
    }
    const data = await response.json().catch(() => null)
    if (response.status !== 409 || attempt === 19) throw new Error(`Mint #${input.tokenId} is confirmed on Stellar Testnet; metadata indexing is still pending and will retry safely. ${data?.error ?? `StellaNova API request failed (${response.status})`}`)
    await new Promise((resolve) => window.setTimeout(resolve, 1000))
  }
  throw new Error(`Mint #${input.tokenId} is confirmed on Stellar Testnet; metadata indexing is still pending and will retry safely.`)
}

export async function fetchMintedNfts(): Promise<MintedNft[]> {
  const response = await fetch('/api/nfts/minted')
  if (!response.ok) throw new Error('Unable to load minted NFTs')
  const data = (await response.json()) as { minted: MintedNft[] }
  return data.minted ?? []
}

/** Fetch the connected wallet's portfolio, including unrevealed collection NFTs. */
export async function fetchOwnedMintedNfts(address: string): Promise<MintedNft[]> {
  const response = await fetch('/api/nfts/minted/owned', { headers: authHeaders(address) })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Unable to load owned NFTs')
  const data = (await response.json()) as { minted: MintedNft[] }
  return data.minted ?? []
}
