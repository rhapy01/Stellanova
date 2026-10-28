import { createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { collectionFor, collections, creatorFor, creators, nfts, sampleCollectionSlugs, type Collection, type Creator, type NFT } from './data'
import { Avatar, Button, Icon, mediaSource, Meta, PrismMark, Toast, Verified } from './ui'
import { connectFreighter, shortenStellarAddress, STELLAR_EXPLORER_URL, type StellarWallet } from './lib/stellar'
import { deploySorobanWasm, invokeSoroban, invokeSorobanBatch, simulateSorobanRead, mintNftWithMetadata, mintFromStage, setCreatorStage, removeCreatorStage, whitelistCreatorWallet, whitelistCreatorWalletBatch, setCreatorReveal, setCreatorTokenUris, getCreatorCollectionTokenIds, getSorobanNftContractId, sendXlmTip } from './lib/deploy'
import * as StellarSdk from '@stellar/stellar-sdk'
import { sorobanMarketplaceConfig, sorobanServer, stellarPaymentAssets } from './lib/soroban'
import { authenticateWallet, clearWalletSession, createPost, recordPostTip, fetchPosts, loadSocialState, fetchNftSocial, fetchNftChainActivity, toggleBookmarkRemote, markNotificationRead, markAllNotificationsRead, fetchNotifications, fetchBrowserPushConfig, saveBrowserPushSubscription, removeBrowserPushSubscription, sendBrowserPushTest, fetchReferralSummary, respondToMarketplaceOffer, postCommentRemote, postToPost, toggleCollectionLike, toggleCollectionDislike, commentOnCollection, fetchCollectionSocial, toggleCreatorFollow, toggleDislikeRemote, toggleLikeRemote, togglePostDislike, togglePostLike, toggleSubscriptionRemote, fetchOwnedNfts, fetchOwnedMintedNfts, fetchAccount, updateProfile, createCollection, updateCollectionProfile, registerNftContract, recordMintedNft, getPendingMintRecords, flushPendingMints, fetchMintedNfts, fetchMarketplaceState, fetchActiveMarketplaceListings, fetchActiveMarketplaceAuctions, fetchActiveMarketplaceCollectionOffers, fetchActiveMarketplaceTraitOffers, fetchCollectionDrop, fetchMintEligibility, createMintStage, updateMintStageMetadata, publishMintStage, deleteMintStage, addWhitelistEntries, removeWhitelistEntry, updateCollectionReveal, fetchCollectionRevealMetadata, fetchPublicCollections, fetchCollectionMintHistory, fetchCreatorProfiles, fetchPublicCreatorProfile, fetchCollectionStories, createCollectionStory, createCreatorStory, markStoryViewed, fetchCollectionDropDraft, saveCollectionDropDraft, clearCollectionDropDraft, fetchCollectionDropResetPlan, fetchAnalyticsOverview, fetchOpsHealth, fetchOpsReconciliation, runOpsReconciliation, createTrackedShareUrl, fetchPublicFeedback, submitPublicFeedback, type PublicFeedbackEntry, type AnalyticsSnapshot, type CollectionDropDraft, type CollectionDropDraftStage, type MarketplaceOffer, type MarketplaceAuction, type MarketplaceCollectionOffer, type MarketplaceTraitOffer, type CollectionStoryGroup, type NotificationRecord, type PostRecord, type SocialComment, type CollectionSocialRecord, type UserAccount, type WalletCollection, type MintedNft, type MintRecordInput, type MarketplaceState, type MarketplaceListing, type MintEligibility, type MintEligibilityStage, type CollectionDrop, type MintStage, type PublicCreatorProfile, type CollectionMintHistoryEntry, type NftChainActivityEntry } from './lib/backend'
import { trackProductEvent } from './lib/product-analytics'
import { MediaAdmin } from './admin-media'
import { useStellarAuth } from './lib/privy-auth'
import { uploadCreatorMetadata, uploadMedia } from './lib/media'
import { fetchNftProvenance, type NftProvenanceRecord } from './lib/backend'
import { authHeaders } from './lib/backend'
import { AiStudioPage, PixelStudioPage, type StudioMintInput } from './create-studio'
import { AiCollectionStudioPage, getRarityTierSchedule, getRarityTierCounts, seededShuffle, type RarityTier, type TransferAsset } from './ai-collection-studio'
import { deleteStudioDraft, loadStudioDraft, saveStudioDraft } from './lib/studio-drafts'
import { PainterStudioPage } from './painter-studio'
import { openCurrentPageInBrowser, telegramWebApp } from './lib/telegram-mini-app'
import { CreatorServicesPage, ExhibitionsPage, PhysicalArtPage } from './creator-economy'

type View = 'home' | 'explore' | 'collections' | 'saved' | 'account' | 'analytics' | 'settings' | 'feedback' | 'services' | 'physical-art' | 'exhibitions' | 'pixel-studio' | 'ai-studio' | 'ai-collection-studio' | 'painter-studio'
type Detail = { type: 'nft'; item: NFT } | { type: 'creator'; id: string } | { type: 'collection'; item: Collection }

const marketTabs = ['All NFTs', 'Buy now', 'Auctions', 'Offers'] as const
type MarketTab = typeof marketTabs[number]
type WalletMode = 'buy' | 'offer' | 'sell' | 'auction' | 'bid'
type WalletActionStatus = 'idle' | 'preparing' | 'awaiting-wallet' | 'confirming' | 'complete' | 'error'
type FeedPreferences = { creatorPosts: boolean; collectibles: boolean }
type OpenPopover = 'notifications' | 'mobile-menu' | 'studios' | 'creative' | 'profile' | null

type ClientNotification = NotificationRecord

function restoreNftComments(): Record<string, SocialComment[]> {
  try {
    const stored = JSON.parse(window.localStorage.getItem('nftgram:comments') ?? '{}') as Record<string, unknown[]>
    return Object.fromEntries(Object.entries(stored).map(([nftId, items]) => [nftId, (Array.isArray(items) ? items : []).map((item, index) => typeof item === 'string'
      ? { id: `local-notification-${nftId}-${index}`, body: item, parent_id: null, created_at: new Date().toISOString() }
      : item as SocialComment)]))
  } catch { return {} }
}

// Token numbers identify the on-chain asset; they are not part of the artwork's display name.
function displayNftTitle(title: string | null | undefined): string {
  return (title ?? '').trim().replace(/\s+#\d+$/, '').trim() || 'Untitled artwork'
}

const CreatorProfilesContext = createContext<Record<string, Creator>>({})
type NftCardActions = {
  walletAddress: string
  marketplace: MarketplaceState | null
  activeListings: MarketplaceListing[]
  activeAuctions: MarketplaceAuction[]
  latestLedger: number
  buy: (item: NFT) => void
  offer: (item: NFT) => void
  sell: (item: NFT) => void
  auction: (item: NFT) => void
  bid: (item: NFT) => void
  cancelAuction: (auctionId: number) => void
  settleAuction: (auctionId: number) => void
  cancelListing: (listingId: number, contractId?: string) => void
  acceptOffer: (offerId: number, contractId?: string) => void
}
const NftCardActionsContext = createContext<NftCardActions>({ walletAddress: '', marketplace: null, activeListings: [], activeAuctions: [], latestLedger: 0, buy: () => {}, offer: () => {}, sell: () => {}, auction: () => {}, bid: () => {}, cancelAuction: () => {}, settleAuction: () => {}, cancelListing: () => {}, acceptOffer: () => {} })

function routeFromPath(path: string): { view: View; detail: Detail | null } {
  const cleanPath = path.split('?')[0]
  if (cleanPath.startsWith('/post/')) return { view: 'home', detail: null }
  if (cleanPath.startsWith('/nft/')) {
    const item = nfts.find((candidate) => candidate.id === cleanPath.split('/')[2])
    if (item) return { view: 'home', detail: { type: 'nft', item } }
  }
  if (cleanPath.startsWith('/creator/')) {
    const id = decodeURIComponent(cleanPath.split('/')[2] ?? '')
    const creator = creators.find((candidate) => candidate.id === id)
    if (id && (creator || /^G[A-Z2-7]{55}$/i.test(id) || /^[a-z][a-z0-9_]{2,23}$/i.test(id))) return { view: 'home', detail: { type: 'creator', id } }
  }
  if (cleanPath.startsWith('/collection/')) {
    const collection = collections.find((candidate) => candidate.id === cleanPath.split('/')[2])
    if (collection) return { view: 'home', detail: { type: 'collection', item: collection } }
  }
  if (cleanPath === '/explore') return { view: 'explore', detail: null }
  if (cleanPath === '/services') return { view: 'services', detail: null }
  if (cleanPath === '/physical-art') return { view: 'physical-art', detail: null }
  if (cleanPath === '/exhibitions') return { view: 'exhibitions', detail: null }
  if (cleanPath === '/collections') return { view: 'collections', detail: null }
  if (cleanPath === '/saved') return { view: 'saved', detail: null }
  if (cleanPath === '/account') return { view: 'account', detail: null }
  if (cleanPath === '/analytics') return { view: 'analytics', detail: null }
  if (cleanPath === '/settings') return { view: 'settings', detail: null }
  if (cleanPath === '/feedback') return { view: 'feedback', detail: null }
  if (cleanPath === '/create/pixel') return { view: 'pixel-studio', detail: null }
  if (cleanPath === '/create/ai') return { view: 'ai-studio', detail: null }
  if (cleanPath === '/create/collection') return { view: 'ai-collection-studio', detail: null }
  if (cleanPath === '/create/painter') return { view: 'painter-studio', detail: null }
  return { view: 'home', detail: null }
}

// Convert a read-model mint record into a browseable NFT card for the Owned feed.
function mintedToNft(m: MintedNft, publicCollections: Collection[] = collections): NFT {
  const collection = publicCollections.find((c) => c.id === m.collection_id)
  return {
    id: `minted-${m.contract_id.toLowerCase()}-${m.token_id}`,
    title: m.title || `NFT #${m.token_id}`,
    creatorId: collection?.creatorId ?? m.minter,
    collectionId: m.collection_id ?? 'standalone-nft',
    image: m.image || '',
    animation_url: m.animation_url,
    attributes: m.attributes ?? [],
    rarity_rank: m.rarity_rank ?? null,
    rarity_score: m.rarity_score === null || m.rarity_score === undefined ? null : Number(m.rarity_score),
    price: 'Not listed',
    priceUsd: '—',
    edition: `1 of 1 · #${m.token_id}`,
    likes: 0,
    comments: 0,
    minted: 'Recorded on Stellar Testnet',
    ownedBy: m.owner_name ? `Owned by ${m.owner_name}` : m.owner_address ? `Owned by ${shortenStellarAddress(m.owner_address)}` : 'Owner updating from Stellar',
    trait: 'Minted',
    saleType: 'Not listed',
    chain: 'Stellar',
    royalty: 'Not configured',
    ownerAddress: m.owner_address ?? undefined,
    tokenId: m.token_id,
    contractId: m.contract_id,
    createdAt: m.created_at,
  }
}

function pendingMintToRecord(input: MintRecordInput, walletAddress: string): MintedNft {
  return {
    contract_id: input.contractId ?? '',
    token_id: input.tokenId,
    minter: walletAddress,
    owner_address: walletAddress,
    collection_id: input.collectionId.startsWith('personal-') ? null : input.collectionId,
    title: input.title || `NFT #${input.tokenId}`,
    image: input.image || '',
    animation_url: null,
    attributes: [],
    price_xlm: input.price === undefined || input.price === null ? null : String(input.price),
    metadata_uri: input.metadataUri,
    created_at: new Date().toISOString(),
  }
}

function creatorFromPublicProfile(profile: PublicCreatorProfile): Creator {
  const walletAddress = profile.wallet_address
  const displayName = typeof profile.display_name === 'string' ? profile.display_name.trim() : ''
  const bio = typeof profile.bio === 'string' ? profile.bio.trim() : ''
  return {
    id: walletAddress,
    name: displayName || (profile.creator_username ? `@${profile.creator_username}` : 'Stellar creator'),
    handle: profile.creator_username ? `@${profile.creator_username}` : '',
    publicSlug: profile.creator_username || undefined,
    avatar: profile.avatar || '',
    bio: bio || 'Creator on Stellar',
    collectorCount: String(profile.collector_count ?? 0),
    collectionCount: String(profile.collection_count ?? 0),
    verified: profile.is_verified,
    accent: '#833ab4',
  }
}

function publicPostAuthorName(post: PostRecord): string {
  const name = post.author_name?.trim()
  if (!name || /^G[A-Z2-7]{5,55}(?:…[A-Z2-7]{4})?$/i.test(name)) {
    return post.author_type === 'collection' ? 'Collection' : 'Creator'
  }
  return name
}

function App() {
  const privyAuth = useStellarAuth()
  const initialRoute = routeFromPath(window.location.pathname)
  const [view, setView] = useState<View>(initialRoute.view)
  const [detail, setDetail] = useState<Detail | null>(initialRoute.detail)
  const routeKey = detail ? `${detail.type}:${detail.type === 'nft' || detail.type === 'collection' ? detail.item.id : detail.id}` : view
  useEffect(() => {
    const pageType = detail?.type ?? view
    trackProductEvent('page_viewed', { page_type: pageType })
    if (view === 'pixel-studio' || view === 'ai-studio' || view === 'ai-collection-studio' || view === 'painter-studio') trackProductEvent('studio_opened', { studio: view })
  }, [view, detail?.type])
  const [pendingCollectionSlug, setPendingCollectionSlug] = useState(() => {
    if (initialRoute.detail?.type === 'collection') return ''
    const parts = window.location.pathname.split('/').filter(Boolean)
    return parts[0] === 'collection' ? decodeURIComponent(parts[1] ?? '') : ''
  })
  const [pendingNftId, setPendingNftId] = useState(() => {
    const parts = window.location.pathname.split('/').filter(Boolean)
    return parts[0] === 'nft' && parts[1] && !nfts.some((item) => item.id === decodeURIComponent(parts[1])) ? decodeURIComponent(parts[1]) : ''
  })
  const [sharedPostId, setSharedPostId] = useState(() => {
    const parts = window.location.pathname.split('/').filter(Boolean)
    return parts[0] === 'post' && /^\d+$/.test(parts[1] ?? '') ? Number(parts[1]) : 0
  })
  const [saved, setSaved] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState('Trending')
  const [marketTab, setMarketTab] = useState<MarketTab>('All NFTs')
  const [sortBy, setSortBy] = useState('Relevance')
  const [walletMode, setWalletMode] = useState<WalletMode>('buy')
  const [walletOpen, setWalletOpen] = useState(false)
  const [walletOverviewOpen, setWalletOverviewOpen] = useState(false)
  const [walletActionStatus, setWalletActionStatus] = useState<WalletActionStatus>('idle')
  const [walletActionError, setWalletActionError] = useState('')
  const [stellarWallet, setStellarWallet] = useState<StellarWallet | null>(null)
  const [walletItem, setWalletItem] = useState<NFT | null>(null)
  const [walletAuction, setWalletAuction] = useState<MarketplaceAuction | null>(null)
  const [toast, setToast] = useState('')
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [introComplete, setIntroComplete] = useState(false)
  const [feedPreferences, setFeedPreferences] = useState<FeedPreferences>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem('nftgram:feed-preferences') ?? '{}') as Partial<FeedPreferences>
      return { creatorPosts: stored.creatorPosts !== false, collectibles: stored.collectibles !== false }
    } catch { return { creatorPosts: true, collectibles: true } }
  })
  const [subscribedCollections, setSubscribedCollections] = useState<string[]>(() => JSON.parse(window.localStorage.getItem('nftgram:subscriptions') ?? '[]'))
  const [collectionSocial, setCollectionSocial] = useState<Record<string, CollectionSocialRecord>>({})
  const [storyGroups, setStoryGroups] = useState<CollectionStoryGroup[]>([])
  const [liked, setLiked] = useState<string[]>(() => JSON.parse(window.localStorage.getItem('nftgram:liked') ?? '[]'))
  const [disliked, setDisliked] = useState<string[]>(() => JSON.parse(window.localStorage.getItem('nftgram:disliked') ?? '[]'))
  const [comments, setComments] = useState<Record<string, SocialComment[]>>(restoreNftComments)
  const [nftSocial, setNftSocial] = useState<Record<string, { likes: number; dislikes: number }>>({})
  const [notifications, setNotifications] = useState<ClientNotification[]>(() => {
    const raw = JSON.parse(window.localStorage.getItem('nftgram:notifications') ?? '[]')
    if (!Array.isArray(raw)) return []
    // Convert stored plain-text notification entries to the current record shape.
    return raw.map((n) => typeof n === 'string' ? { id: 0, kind: 'local', title: '', body: n, read_at: null, created_at: '' } : n as ClientNotification)
  })
  const [unreadCount, setUnreadCount] = useState(0)
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null)
  const togglePopover = (popover: Exclude<OpenPopover, null>) => setOpenPopover((current) => current === popover ? null : popover)
  const notificationsOpen = openPopover === 'notifications'
  const [browserPushState, setBrowserPushState] = useState<'unsupported' | 'off' | 'on' | 'denied'>(() => !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) ? 'unsupported' : Notification.permission === 'denied' ? 'denied' : 'off')
  const [browserPushBusy, setBrowserPushBusy] = useState(false)
  const [browserPushTestBusy, setBrowserPushTestBusy] = useState(false)
  const navMenuOpen = openPopover === 'mobile-menu'
  const studioNavOpen = openPopover === 'studios'
  const creativeNavOpen = openPopover === 'creative'
  const profileNavOpen = openPopover === 'profile'
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && !target.closest('[data-popover-trigger], [data-popover-content]')) setOpenPopover(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenPopover(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])
  const [posts, setPosts] = useState<PostRecord[]>([])
  const [postsLoadState, setPostsLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [creatorFollows, setCreatorFollows] = useState<string[]>(() => JSON.parse(window.localStorage.getItem('nftgram:creator-follows') ?? '[]'))
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeText, setComposeText] = useState('')
  const [composeFile, setComposeFile] = useState<File | null>(null)
  const [composeNft, setComposeNft] = useState('')
  const [posting, setPosting] = useState(false)
  const [createChooserOpen, setCreateChooserOpen] = useState(false)
  const [account, setAccount] = useState<UserAccount | null>(null)
  const [walletCollections, setWalletCollections] = useState<WalletCollection[]>([])
  const [allCollections, setAllCollections] = useState<Collection[]>([])
  const [creatorProfiles, setCreatorProfiles] = useState<Record<string, Creator>>({})
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardName, setOnboardName] = useState('')
  const [onboardSymbol, setOnboardSymbol] = useState('')
  const [onboardDesc, setOnboardDesc] = useState('')
  const [onboardSupply, setOnboardSupply] = useState('')
  const [onboardCover, setOnboardCover] = useState<File | null>(null)
  const [collectionCreating, setCollectionCreating] = useState(false)
  const [ownedTokens, setOwnedTokens] = useState<{ contract_id: string; token_id: number }[]>([])
  // Tracks whether authoritative indexed ownership is available for the connected
  // wallet: 'pending' before the query returns, 'indexed' when the backend is
  // reachable (even if the wallet owns nothing), or 'unavailable' when the indexer
  // is offline/unconfigured. Ownership validation is relaxed only on 'pending' /
  // 'unavailable' means the portfolio cannot be confirmed. Never infer ownership.
  const [ownershipSource, setOwnershipSource] = useState<'pending' | 'indexed' | 'unavailable'>('pending')
  const [mintOpen, setMintOpen] = useState(false)
  const [mintTargetCollectionSlug, setMintTargetCollectionSlug] = useState('')
  const [firstCollectionMintStep, setFirstCollectionMintStep] = useState(false)
  const [mintSuccess, setMintSuccess] = useState<{ tokenId: number; title: string; image: string; contractId: string; txHash: string; indexed?: boolean } | null>(null)
  const [mintTitle, setMintTitle] = useState('')
  const [mintError, setMintError] = useState('')
  const [mintDescription, setMintDescription] = useState('')
  const [mintFile, setMintFile] = useState<File | null>(null)
  const [mintArtworkUrl, setMintArtworkUrl] = useState('')
  const [mintMediaFile, setMintMediaFile] = useState<File | null>(null)
  const [mintTraits, setMintTraits] = useState('')
  const [mintedNfts, setMintedNfts] = useState<MintedNft[]>([])
  const [accountOwnedMints, setAccountOwnedMints] = useState<MintedNft[]>([])
  const [activeListings, setActiveListings] = useState<MarketplaceListing[]>([])
  const [activeAuctions, setActiveAuctions] = useState<MarketplaceAuction[]>([])
  const [latestLedger, setLatestLedger] = useState(0)
  const [pendingMintInputs, setPendingMintInputs] = useState<MintRecordInput[]>([])
  const [minting, setMinting] = useState(false)
  const [marketplace, setMarketplace] = useState<MarketplaceState | null>(null)
  const marketNfts = useMemo(() => {
    const records = [...mintedNfts]
    if (stellarWallet) for (const input of pendingMintInputs) {
      const pending = pendingMintToRecord(input, stellarWallet.address)
      if (!records.some((mint) => mint.contract_id.toLowerCase() === pending.contract_id.toLowerCase() && mint.token_id === pending.token_id)) records.push(pending)
    }
    const items = records.map((mint) => mintedToNft(mint, allCollections))
    return items.map((item) => {
      const listing = activeListings.find((entry) => entry.nft_contract.toLowerCase() === item.contractId?.toLowerCase() && entry.token_id === item.tokenId)
      if (!listing) {
        const auction = activeAuctions.find((entry) => entry.nft_contract.toLowerCase() === item.contractId?.toLowerCase() && entry.token_id === item.tokenId)
        if (!auction) return item
        const amount = BigInt(auction.highest_bid || '0') > 0n ? auction.highest_bid : auction.reserve_price
        const ledgersRemaining = auction.ends_at - latestLedger
        const timeRemaining = ledgersRemaining > 0 ? `${Math.max(1, Math.ceil(ledgersRemaining / 720))}h remaining` : 'Auction ended · settlement pending'
        const paymentAsset = stellarPaymentAssets.find((asset) => asset.contractId.toLowerCase() === auction.payment_token.toLowerCase())
        return { ...item, ownerAddress: auction.seller, price: `${formatTokenAmount(amount, paymentAsset?.decimals ?? 7)} ${paymentAsset?.code ?? 'Token'}`, saleType: 'Auction' as const, auctionEnds: timeRemaining }
      }
      // Listed NFTs are held in marketplace escrow. For app ownership and
      // owner-only actions, the listing seller remains the owner's wallet.
      const paymentAsset = stellarPaymentAssets.find((asset) => asset.contractId.toLowerCase() === listing.payment_token.toLowerCase())
      return { ...item, ownerAddress: listing.seller, price: `${formatTokenAmount(listing.price, paymentAsset?.decimals ?? 7)} ${paymentAsset?.code ?? 'Token'}`, saleType: 'Buy now' as const }
    })
  }, [mintedNfts, pendingMintInputs, stellarWallet?.address, allCollections, activeListings, activeAuctions, latestLedger])
  const socializedMarketNfts = useMemo(() => marketNfts.map((item) => ({
    ...item,
    likes: nftSocial[item.id]?.likes ?? item.likes,
    comments: comments[item.id]?.length ?? item.comments,
  })), [marketNfts, nftSocial, comments])

  useEffect(() => {
    let active = true
    const refresh = () => {
      void fetchActiveMarketplaceListings().then((items) => { if (active) setActiveListings(items) }).catch(() => {})
      void fetchActiveMarketplaceAuctions().then((items) => { if (active) setActiveAuctions(items) }).catch(() => {})
      void sorobanServer.getLatestLedger().then((ledger) => { if (active) setLatestLedger(ledger.sequence) }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (!allCollections.length) return
    let active = true
    void fetchCollectionSocial(allCollections.map((collection) => collection.id), stellarWallet?.address ?? '').then((rows) => {
      if (!active) return
      setCollectionSocial((current) => ({ ...current, ...Object.fromEntries(rows.map((row) => [row.collection_id, row])) }))
    }).catch(() => {})
    return () => { active = false }
  }, [allCollections, stellarWallet?.address])

  useEffect(() => {
    if (!pendingNftId) return
    const item = marketNfts.find((candidate) => candidate.id === pendingNftId)
    if (!item) return
    setDetail({ type: 'nft', item })
    setView('home')
    setPendingNftId('')
  }, [marketNfts, pendingNftId])

  useEffect(() => {
    if (!sharedPostId) return
    let active = true
    void fetchPosts(stellarWallet?.address, undefined, sharedPostId).then((items) => {
      if (!active || !items[0]) return
      setPosts((current) => [items[0], ...current.filter((post) => post.id !== sharedPostId)])
    }).catch(() => {})
    return () => { active = false }
  }, [sharedPostId, stellarWallet?.address])

  useLayoutEffect(() => {
    if (!sharedPostId) return
    document.getElementById(`post-${sharedPostId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [posts, sharedPostId])

  const creatorWalletIds = useMemo(() => [...new Set([
    ...marketNfts.map((item) => item.creatorId),
    ...marketNfts.map((item) => item.ownerAddress ?? ''),
    ...allCollections.map((collection) => collection.creatorId),
    ...posts.filter((post) => post.author_type === 'user').map((post) => post.author),
  ].filter((id) => /^G[A-Z2-7]{55}$/.test(id)))], [marketNfts, allCollections, posts])

  useEffect(() => {
    let active = true
    if (!creatorWalletIds.length) return () => { active = false }
    void fetchCreatorProfiles(creatorWalletIds).then((profiles) => {
      if (!active) return
      setCreatorProfiles((current) => ({
        ...current,
        ...Object.fromEntries(profiles.map((profile) => [profile.wallet_address.toLowerCase(), creatorFromPublicProfile(profile)])),
      }))
    }).catch(() => {})
    return () => { active = false }
  }, [creatorWalletIds])

  useEffect(() => {
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 120 : 760
    const timer = window.setTimeout(() => setIntroComplete(true), duration)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    window.localStorage.setItem('nftgram:feed-preferences', JSON.stringify(feedPreferences))
    window.localStorage.setItem('nftgram:subscriptions', JSON.stringify(subscribedCollections))
    window.localStorage.setItem('nftgram:liked', JSON.stringify(liked))
    window.localStorage.setItem('nftgram:disliked', JSON.stringify(disliked))
    window.localStorage.setItem('nftgram:comments', JSON.stringify(comments))
    window.localStorage.setItem('nftgram:notifications', JSON.stringify(notifications))
    window.localStorage.setItem('nftgram:creator-follows', JSON.stringify(creatorFollows))
  }, [comments, disliked, feedPreferences, liked, notifications, subscribedCollections, creatorFollows])

  useEffect(() => {
    let active = true
    const checkBrowserPush = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (active) setBrowserPushState('unsupported')
        return
      }
      if (Notification.permission === 'denied') {
        if (active) setBrowserPushState('denied')
        return
      }
      try {
        const registration = await navigator.serviceWorker.getRegistration()
        const subscription = await registration?.pushManager.getSubscription()
        if (!active) return
        setBrowserPushState(subscription ? 'on' : 'off')
        if (subscription && stellarWallet) {
          await saveBrowserPushSubscription(stellarWallet.address, subscription.toJSON()).catch(() => undefined)
        }
      } catch {
        if (active) setBrowserPushState('off')
      }
    }
    void checkBrowserPush()
    return () => { active = false }
  }, [stellarWallet?.address])

  const loadPosts = useCallback(async () => {
    setPostsLoadState('loading')
    try {
      setPosts(await fetchPosts())
      setPostsLoadState('ready')
    } catch {
      setPostsLoadState('error')
    }
  }, [])

  useEffect(() => { void loadPosts() }, [loadPosts])
  useEffect(() => {
    const refreshFeed = () => { void loadPosts() }
    window.addEventListener('nftgram:refresh-feed', refreshFeed)
    return () => window.removeEventListener('nftgram:refresh-feed', refreshFeed)
  }, [loadPosts])
  useEffect(() => {
    const openCreator = (event: Event) => {
      const creator = (event as CustomEvent<{ creator?: string }>).detail?.creator
      if (creator) { setView('home'); setDetail({ type: 'creator', id: creator }) }
    }
    window.addEventListener('stellanova:open-creator', openCreator)
    return () => window.removeEventListener('stellanova:open-creator', openCreator)
  }, [])

  useEffect(() => {
    void fetchMintedNfts().then(setMintedNfts).catch(() => {})
    void fetchPublicCollections().then((rows) => setAllCollections(rows.map((row) => ({
      id: row.slug, name: row.name, symbol: row.symbol, creatorId: row.owner_wallet,
      cover: row.cover, floor: '—', volume: '—', items: String(row.nft_count), change: '—', description: row.description, contractId: row.contract_id ?? undefined,
      totalSupply: row.total_supply, websiteUrl: row.website_url, socialLinks: row.social_links ?? {},
      isSample: sampleCollectionSlugs.has(row.slug), mintingNow: row.minting_now, revealed: row.revealed,
    })))).catch(() => {})
  }, [])

  useEffect(() => {
    let active = true
    const ids = marketNfts.map((item) => item.id)
    void fetchNftSocial(ids, stellarWallet?.address ?? '').then((records) => {
      if (!active) return
      setNftSocial(Object.fromEntries(records.map((row) => [row.nft_id, { likes: row.likes, dislikes: row.dislikes }])))
      setLiked((current) => stellarWallet ? [...new Set([...current.filter((id) => !ids.includes(id)), ...records.filter((row) => row.liked).map((row) => row.nft_id)])] : current)
      setDisliked((current) => stellarWallet ? [...new Set([...current.filter((id) => !ids.includes(id)), ...records.filter((row) => row.disliked).map((row) => row.nft_id)])] : current)
      setComments((current) => Object.fromEntries([...Object.entries(current).filter(([id]) => !ids.includes(id)), ...records.map((row) => [row.nft_id, row.comments])]))
    }).catch((error) => console.warn('NFT social activity could not be loaded', error))
    return () => { active = false }
  }, [marketNfts, stellarWallet?.address])

  useEffect(() => {
    if (!pendingCollectionSlug) return
    const collection = allCollections.find((item) => item.id.toLowerCase() === pendingCollectionSlug.toLowerCase())
    if (!collection) return
    setView('account')
    setDetail({ type: 'collection', item: collection })
    setPendingCollectionSlug('')
  }, [allCollections, pendingCollectionSlug])

  // A profile collection card can be clicked before the public collection list
  // has finished loading. Replace that temporary fallback with the canonical
  // record as soon as it arrives (including the real cover URL).
  useEffect(() => {
    if (detail?.type !== 'collection') return
    const latest = allCollections.find((item) => item.id.toLowerCase() === detail.item.id.toLowerCase())
    if (!latest) return
    if (detail.item.cover === latest.cover && detail.item.description === latest.description && detail.item.contractId === latest.contractId) return
    setDetail((current) => current?.type === 'collection' && current.item.id === latest.id ? { ...current, item: latest } : current)
  }, [allCollections, detail])

  useEffect(() => {
    if (!stellarWallet) return
    const syncPendingMints = () => {
      void flushPendingMints(stellarWallet.address).then((indexed) => {
        if (indexed) {
          void fetchMintedNfts().then(setMintedNfts).catch(() => {})
          setPendingMintInputs(getPendingMintRecords(stellarWallet.address))
        }
      }).catch(() => {})
    }
    syncPendingMints()
    const timer = window.setInterval(syncPendingMints, 30_000)
    return () => window.clearInterval(timer)
  }, [stellarWallet?.address])

  useEffect(() => {
    if (!stellarWallet) { setStoryGroups([]); return }
    let active = true
    void fetchCollectionStories(stellarWallet.address).then(({ groups }) => { if (active) setStoryGroups(groups) }).catch(() => { if (active) setStoryGroups([]) })
    return () => { active = false }
  }, [stellarWallet?.address, subscribedCollections, creatorFollows])

  useEffect(() => {
    if (!stellarWallet) return
    setPendingMintInputs(getPendingMintRecords(stellarWallet.address))
    void loadSocialState(stellarWallet.address).then((state) => {
      setSubscribedCollections(state.subscriptions)
      setLiked(state.likes)
      setDisliked([...state.dislikes, ...state.postDislikes.map((id) => `post:${id}`)])
      setSaved(state.bookmarks ?? [])
      setComments(state.comments.reduce<Record<string, SocialComment[]>>((result, comment) => ({ ...result, [comment.nft_id]: [...(result[comment.nft_id] ?? []), comment] }), {}))
      setNotifications(state.notifications)
      setUnreadCount(state.unreadCount ?? 0)
      setCreatorFollows(state.creatorFollows)
    }).catch((error) => {
      // Loading the wallet's social preferences is a background sync. Keep the
      // feed usable from its cached state and leave diagnostics in the console;
      // calling this "offline social mode" is misleading and interrupts login.
      console.warn('Wallet social state could not be synced', error)
    })
    void fetchPosts(stellarWallet.address).then((serverPosts) => {
      setPosts((current) => {
        return serverPosts
      })
      setPostsLoadState('ready')
    }).catch(() => setPostsLoadState('error'))
    setOwnershipSource('pending')
    void fetchOwnedNfts(stellarWallet.address)
      .then((owned) => {
        setOwnedTokens(owned.map(({ contract_id, token_id }) => ({ contract_id, token_id })))
        setOwnershipSource('indexed')
      })
      .catch(() => setOwnershipSource('unavailable'))
    void fetchMarketplaceState(stellarWallet.address)
      .then(setMarketplace)
      .catch(() => {})
  }, [stellarWallet])

  useEffect(() => {
    if (!stellarWallet) { setNotifications((current) => current.filter((item) => item.id === 0)); setUnreadCount(0); return }
    let active = true
    const refresh = () => void fetchNotifications(stellarWallet.address).then((data) => {
      if (!active) return
      setNotifications((current) => [...data.notifications, ...current.filter((item) => item.id === 0)].slice(0, 50))
      setUnreadCount(data.unreadCount)
    }).catch(() => {})
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [stellarWallet?.address])

  // Refresh the portfolio when it is opened so confirmed tokens recorded since
  // the app first loaded are visible without a hard page reload.
  useEffect(() => {
    if (view !== 'account' || !stellarWallet) return
    let active = true
    const address = stellarWallet.address
    setPendingMintInputs(getPendingMintRecords(stellarWallet.address))
    setAccountOwnedMints([])
    void fetchMintedNfts().then((items) => { if (active) setMintedNfts(items) }).catch(() => {})
    void fetchOwnedMintedNfts(address).then((items) => { if (active) setAccountOwnedMints(items) }).catch((error) => console.warn('Private portfolio mint records could not be loaded', error))
    void fetchOwnedNfts(stellarWallet.address).then((owned) => {
      if (!active) return
      setOwnedTokens(owned.map(({ contract_id, token_id }) => ({ contract_id, token_id })))
      setOwnershipSource('indexed')
    }).catch(() => {})
    const refreshMarketplaceForAccount = () => {
      void fetchMarketplaceState(address).then((state) => { if (active) setMarketplace(state) }).catch(() => {})
    }
    refreshMarketplaceForAccount()
    const marketplaceRefresh = window.setInterval(refreshMarketplaceForAccount, 15_000)
    return () => { active = false; window.clearInterval(marketplaceRefresh) }
  }, [view, stellarWallet?.address])

  useEffect(() => {
    const syncOnline = () => setIsOnline(navigator.onLine)
    const syncRoute = () => {
      const nextRoute = routeFromPath(window.location.pathname)
      setView(nextRoute.view)
      setDetail(nextRoute.detail)
      const parts = window.location.pathname.split('/').filter(Boolean)
      setSharedPostId(parts[0] === 'post' && /^\d+$/.test(parts[1] ?? '') ? Number(parts[1]) : 0)
      setPendingNftId(parts[0] === 'nft' && !nextRoute.detail ? decodeURIComponent(parts[1] ?? '') : '')
    }
    window.addEventListener('online', syncOnline)
    window.addEventListener('offline', syncOnline)
    window.addEventListener('popstate', syncRoute)
    return () => {
      window.removeEventListener('online', syncOnline)
      window.removeEventListener('offline', syncOnline)
      window.removeEventListener('popstate', syncRoute)
    }
  }, [])

  useEffect(() => {
    if (window.location.pathname === '/admin/deploy') return
    if ((pendingCollectionSlug || pendingNftId) && !detail) return
    const path = sharedPostId ? `/post/${sharedPostId}` : detail?.type === 'nft' ? `/nft/${detail.item.id}` : detail?.type === 'creator' ? `/creator/${detail.id}` : detail?.type === 'collection' ? `/collection/${detail.item.id}` : view === 'home' ? '/' : view === 'pixel-studio' ? '/create/pixel' : view === 'ai-studio' ? '/create/ai' : view === 'ai-collection-studio' ? '/create/collection' : view === 'painter-studio' ? '/create/painter' : `/${view}`
    if (window.location.pathname !== path) window.history.pushState({ stellaNovaRoute: true }, '', path)
  }, [detail, pendingCollectionSlug, pendingNftId, sharedPostId, view])

  useEffect(() => {
    const pathname = window.location.pathname
    // Dynamic share pages already arrive with server-rendered metadata. Keep
    // their item-specific title/description while React loads their data.
    if (!detail && (pathname.startsWith('/collection/') || pathname.startsWith('/nft/') || pathname.startsWith('/post/'))) return
    let title = 'StellaNova — Social marketplace for digital art'
    let description = 'Discover digital art, follow creators, and collect NFTs on Stellar.'
    if (detail?.type === 'nft') {
      title = `${detail.item.title} · StellaNova`
      description = `View ${detail.item.title} on StellaNova.`
    } else if (detail?.type === 'collection') {
      title = `${detail.item.name} · StellaNova`
      description = detail.item.description?.trim() || `Explore ${detail.item.name} on StellaNova.`
    } else if (detail?.type === 'creator') {
      const creator = creators.find((item) => item.id === detail.id)
      title = `${creator?.name || 'Creator'} · StellaNova`
      description = creator?.bio?.trim() || `Explore artwork and collections from ${creator?.name || 'this creator'} on StellaNova.`
    } else {
      const pageMetadata: Partial<Record<View, { title: string; description: string }>> = {
        home: { title: 'StellaNova — Social marketplace for digital art', description },
        explore: { title: 'Explore digital art · StellaNova', description: 'Browse digital artwork and NFTs shared by creators on StellaNova.' },
        services: { title: 'Hire a creator · StellaNova', description: 'Find artists for commissions and creative projects, agree terms, and pay in XLM.' },
        'physical-art': { title: 'Original physical art · StellaNova', description: 'Discover and buy original tangible artworks from creators using XLM.' },
        exhibitions: { title: 'Real-world art exhibitions · StellaNova', description: 'Discover in-person exhibitions and art events organized by StellaNova creators.' },
        collections: { title: 'NFT collections · StellaNova', description: 'Discover creator collections and live drops on StellaNova.' },
        analytics: { title: 'Marketplace analytics · StellaNova', description: 'Explore verified Stellar marketplace activity on StellaNova.' },
        feedback: { title: 'Community feedback · StellaNova', description: 'Share ideas, report problems, and follow feedback from the StellaNova community.' },
      }
      const page = pageMetadata[view]
      if (page) ({ title, description } = page)
    }
    document.title = title
    const setMeta = (selector: string, attribute: string, value: string) => {
      let element = document.head.querySelector<HTMLMetaElement>(selector)
      if (!element) { element = document.createElement('meta'); element.setAttribute(attribute, selector.match(/name="([^"]+)"/)?.[1] ?? selector.match(/property="([^"]+)"/)?.[1] ?? ''); document.head.appendChild(element) }
      element.content = value
    }
    setMeta('meta[name="description"]', 'name', description)
    setMeta('meta[property="og:title"]', 'property', title)
    setMeta('meta[property="og:description"]', 'property', description)
    setMeta('meta[name="twitter:title"]', 'name', title)
    setMeta('meta[name="twitter:description"]', 'name', description)
    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.appendChild(canonical) }
    canonical.href = `${window.location.origin}${pathname}`
    let robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]')
    if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.appendChild(robots) }
    robots.content = /^\/(account|saved|settings|analytics|create|admin)(\/|$)/.test(pathname) ? 'noindex, nofollow' : 'index, follow'
  }, [detail, view])

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [routeKey])

  const notify = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 4500)
  }

  const copyStellarAddress = async (address: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address)
      } else {
        const field = document.createElement('textarea')
        field.value = address
        field.setAttribute('readonly', '')
        field.style.position = 'fixed'
        field.style.opacity = '0'
        document.body.appendChild(field)
        field.select()
        const copied = document.execCommand('copy')
        field.remove()
        if (!copied) throw new Error('Clipboard copy failed')
      }
      notify('Stellar address copied')
    } catch {
      notify('Could not copy address. Select and copy it manually.')
    }
  }

  useEffect(() => {
    if (!privyAuth.wallet) return
    setStellarWallet(privyAuth.wallet)
    if (!walletItem) setWalletOpen(false)
    notify(`Your Stellar wallet is ready: ${shortenStellarAddress(privyAuth.wallet.address)}`)
    void fetchAccount(privyAuth.wallet.address).then((data) => {
      setAccount(data.account)
      setWalletCollections(data.collections)
    }).catch(() => {})
  }, [privyAuth.wallet])

  useEffect(() => {
    if (!privyAuth.wallet && privyAuth.error && stellarWallet?.provider === 'Privy') setStellarWallet(null)
  }, [privyAuth.wallet, privyAuth.error, stellarWallet])

  useEffect(() => {
    if (privyAuth.error) notify(privyAuth.error)
  }, [privyAuth.error])

  const handleMarkRead = (id: number) => {
    setNotifications((current) => {
      const next = current.map((note) => note.id === id ? { ...note, read_at: note.read_at ?? new Date().toISOString() } : note)
      setUnreadCount(next.filter((note) => !note.read_at).length)
      return next
    })
    if (stellarWallet && id !== 0) void markNotificationRead(stellarWallet.address, id).catch(() => notify('Mark-as-read saved locally; server sync unavailable'))
  }

  const handleMarkAllRead = async () => {
    const timestamp = new Date().toISOString()
    setNotifications((current) => current.map((note) => ({ ...note, read_at: note.read_at ?? timestamp })))
    setUnreadCount(0)
    if (!stellarWallet) return
    try {
      await markAllNotificationsRead(stellarWallet.address)
    } catch {
      notify('Could not sync read status. Reopen notifications to refresh.')
      void fetchNotifications(stellarWallet.address).then((data) => { setNotifications(data.notifications); setUnreadCount(data.unreadCount) }).catch(() => undefined)
    }
  }

  const handleBrowserPushToggle = async () => {
    if (browserPushBusy) return
    if (!stellarWallet) { notify('Connect your wallet to enable browser alerts'); return }
    setBrowserPushBusy(true)
    try {
      if (browserPushState !== 'on') {
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
          setBrowserPushState(permission === 'denied' ? 'denied' : 'off')
          if (permission === 'denied') notify('Allow notifications for StellaNova in your browser settings to turn on alerts')
          return
        }
      }
      const registration = await navigator.serviceWorker.ready
      const current = await registration.pushManager.getSubscription()
      if (current) {
        await removeBrowserPushSubscription(stellarWallet.address, current.endpoint)
        await current.unsubscribe()
        setBrowserPushState('off')
        notify('Browser alerts are off')
        return
      }
      const config = await fetchBrowserPushConfig()
      if (!config.enabled || !config.publicKey) throw new Error('Browser alerts are being set up. Try again shortly.')
      const base64 = config.publicKey.replace(/-/g, '+').replace(/_/g, '/')
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
      const applicationServerKey = Uint8Array.from(window.atob(padded), (character) => character.charCodeAt(0)).buffer as ArrayBuffer
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
      await saveBrowserPushSubscription(stellarWallet.address, subscription.toJSON())
      setBrowserPushState('on')
      notify('Browser alerts are on')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not update browser alerts')
    } finally {
      setBrowserPushBusy(false)
    }
  }

  const handleBrowserPushTest = async () => {
    if (!stellarWallet || browserPushTestBusy) return
    setBrowserPushTestBusy(true)
    try {
      const result = await sendBrowserPushTest(stellarWallet.address)
      notify(result.failed ? `Push service accepted ${result.sent} alert(s); ${result.failed} delivery failed.` : `Push service accepted the test for ${result.sent} device(s). Check this phone’s notification shade.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not send a test browser alert')
    } finally {
      setBrowserPushTestBusy(false)
    }
  }

  const handleNotificationClick = (note: ClientNotification) => {
    handleMarkRead(note.id)
    setOpenPopover(null)
    let actionUrl = note.action_url || ''
    const link = note.body.match(/https?:\/\/[^\s]+/)?.[0]
    if (!actionUrl && link) {
      try { actionUrl = new URL(link).pathname } catch { /* Ignore malformed legacy links. */ }
    }
    let targetNftId = ''
    let targetPostId = 0
    let targetCollectionId = ''
    if (actionUrl) {
      try {
        const pathname = actionUrl.startsWith('/') ? actionUrl : new URL(actionUrl).pathname
        const match = pathname.match(/^\/nft\/([^/]+)\/?$/)
        if (match) targetNftId = decodeURIComponent(match[1])
        const postMatch = pathname.match(/^\/post\/(\d+)\/?$/)
        if (postMatch) targetPostId = Number(postMatch[1])
        const collectionMatch = pathname.match(/^\/collection\/([^/]+)\/?$/)
        if (collectionMatch) targetCollectionId = decodeURIComponent(collectionMatch[1])
      } catch { /* Ignore malformed links in old notification content. */ }
    }
    if ((note.kind.startsWith('post_') || note.kind === 'post_tip') && targetPostId) {
      navTo('home')
      setSharedPostId(targetPostId)
      return
    }
    if (targetCollectionId) {
      const collection = allCollections.find((item) => item.id.toLowerCase() === targetCollectionId.toLowerCase())
      setView('account')
      if (collection) setDetail({ type: 'collection', item: collection })
      else setPendingCollectionSlug(targetCollectionId)
      return
    }
    if (targetNftId) {
      const item = marketNfts.find((candidate) => candidate.id === targetNftId)
      setView('home')
      if (item) {
        setPendingNftId('')
        setDetail({ type: 'nft', item })
      } else {
        setDetail(null)
        setPendingNftId(targetNftId)
        void fetchMintedNfts().then(setMintedNfts).catch(() => {})
      }
      return
    }
    if (note.kind.includes('offer') || note.kind.startsWith('counter_')) navTo('account')
  }

  const toggleSaved = (id: string) => {
    if (!stellarWallet) { notify('Connect your Stellar wallet to save this NFT across devices'); return }
    const wasSaved = saved.includes(id)
    setSaved((current) => wasSaved ? current.filter((item) => item !== id) : [...current, id])
    void toggleBookmarkRemote(stellarWallet.address, id).then(({ saved: nowSaved }) => {
      setSaved((current) => nowSaved ? [...new Set([...current, id])] : current.filter((item) => item !== id))
      notify(nowSaved ? 'Saved to your gallery' : 'Removed from saved')
    }).catch(() => {
      setSaved((current) => wasSaved ? [...new Set([...current, id])] : current.filter((item) => item !== id))
      notify('Could not save this NFT. Check your connection and try again.')
    })
  }

  const filteredNfts = useMemo(() => {
    const term = search.toLowerCase().trim()
    return marketNfts.filter((item) => {
      const creator = creatorFor(item.creatorId, creatorProfiles)
      const collection = collectionFor(item.collectionId)
      const matchesSearch = !term || [item.title, creator.name, collection.name, item.trait].some((value) => value.toLowerCase().includes(term))
      const matchesFilter = activeFilter === 'Trending' || (activeFilter === 'New drops' ? item.minted.includes('hour') : activeFilter === '1/1s' ? item.edition === '1 of 1' : Number.parseFloat(item.price) < 1)
      const matchesMarket = marketTab === 'All NFTs' || (marketTab === 'Buy now' ? item.saleType === 'Buy now' : marketTab === 'Auctions' ? item.saleType === 'Auction' : item.saleType === 'Offers')
      return matchesSearch && matchesFilter && matchesMarket
    }).sort((a, b) => {
      const price = (item: NFT) => Number.parseFloat(item.price.replace(/[^\d.]/g, '')) || Number.POSITIVE_INFINITY
      if (sortBy === 'Price low') return price(a) - price(b)
      if (sortBy === 'Price high') return price(b) - price(a)
      if (sortBy === 'Newest') return (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0)
      if (sortBy === 'Ending soon') {
        const end = (item: NFT) => activeAuctions.find((auction) => auction.nft_contract.toLowerCase() === item.contractId?.toLowerCase() && auction.token_id === item.tokenId)?.ends_at ?? Number.POSITIVE_INFINITY
        return end(a) - end(b)
      }
      return b.likes - a.likes
    })
  }, [activeAuctions, activeFilter, creatorProfiles, marketNfts, marketTab, search, sortBy])

  const openNft = (item: NFT) => setDetail({ type: 'nft', item: { ...item, likes: nftSocial[item.id]?.likes ?? item.likes, comments: comments[item.id]?.length ?? item.comments } })
  const navTo = (nextView: View) => {
    setPendingNftId('')
    setSharedPostId(0)
    setDetail(null)
    setView(nextView)
  }

  useEffect(() => {
    const backButton = telegramWebApp()?.BackButton
    if (!backButton) return
    const shouldShow = Boolean(detail) || view !== 'home'
    const handleTelegramBack = () => {
      if (detail) setDetail(null)
      else navTo('home')
    }
    if (shouldShow) {
      backButton.show()
      backButton.onClick(handleTelegramBack)
    } else backButton.hide()
    return () => {
      if (shouldShow) backButton.offClick(handleTelegramBack)
      backButton.hide()
    }
  }, [detail, view])

  const handleSearch = (value: string) => {
    setSearch(value)
    if (value && view !== 'explore' && !detail) navTo('explore')
  }

  const openWallet = (item: NFT | null = null, mode: WalletMode = 'buy') => {
    setWalletItem(item)
    setWalletMode(mode)
    setWalletAuction(mode === 'bid' && item?.contractId && item.tokenId !== undefined
      ? activeAuctions.find((auction) => auction.nft_contract.toLowerCase() === item.contractId!.toLowerCase() && auction.token_id === item.tokenId) ?? null
      : null)
    setWalletActionStatus('idle')
    setWalletActionError('')
    setWalletOpen(true)
  }

  const ownedItems = useMemo(() => {
    if (!stellarWallet) return []
    if (ownershipSource !== 'indexed') return []
    return marketNfts.filter((item) => item.tokenId !== undefined && item.contractId && ownedTokens.some((token) => token.token_id === item.tokenId && token.contract_id.toLowerCase() === item.contractId?.toLowerCase()))
  }, [ownedTokens, ownershipSource, stellarWallet, marketNfts])
  const toggleLike = (id: string) => {
    if (!stellarWallet) { notify('Connect your Stellar wallet to like NFTs'); return }
    const wasLiked = liked.includes(id)
    const wasDisliked = disliked.includes(id)
    setLiked((current) => wasLiked ? current.filter((item) => item !== id) : [...current, id])
    setDisliked((current) => current.filter((item) => item !== id))
    setNftSocial((current) => ({ ...current, [id]: { likes: Math.max(0, (current[id]?.likes ?? 0) + (wasLiked ? -1 : 1)), dislikes: Math.max(0, (current[id]?.dislikes ?? 0) - (wasDisliked ? 1 : 0)) } }))
    void toggleLikeRemote(stellarWallet.address, id).then(async () => {
      const [row] = await fetchNftSocial([id], stellarWallet.address)
      if (row) setNftSocial((current) => ({ ...current, [id]: { likes: row.likes, dislikes: row.dislikes } }))
    }).catch(() => {
      setLiked((current) => wasLiked ? [...new Set([...current, id])] : current.filter((item) => item !== id))
      setDisliked((current) => wasDisliked ? [...new Set([...current, id])] : current.filter((item) => item !== id))
      setNftSocial((current) => ({ ...current, [id]: { likes: Math.max(0, (current[id]?.likes ?? 0) + (wasLiked ? 1 : -1)), dislikes: Math.max(0, (current[id]?.dislikes ?? 0) + (wasDisliked ? 1 : 0)) } }))
      notify('Like could not be saved. Check your connection and try again.')
    })
  }
  const toggleDislike = (id: string) => {
    if (!stellarWallet) { notify('Connect your Stellar wallet to react to NFTs'); return }
    const wasDisliked = disliked.includes(id)
    setDisliked((current) => wasDisliked ? current.filter((item) => item !== id) : [...current, id])
    const wasLiked = liked.includes(id)
    if (!wasDisliked && wasLiked) setLiked((current) => current.filter((item) => item !== id))
    setNftSocial((current) => ({ ...current, [id]: { likes: Math.max(0, (current[id]?.likes ?? 0) - (!wasDisliked && wasLiked ? 1 : 0)), dislikes: Math.max(0, (current[id]?.dislikes ?? 0) + (wasDisliked ? -1 : 1)) } }))
    void toggleDislikeRemote(stellarWallet.address, id).then(async () => {
      const [row] = await fetchNftSocial([id], stellarWallet.address)
      if (row) setNftSocial((current) => ({ ...current, [id]: { likes: row.likes, dislikes: row.dislikes } }))
    }).catch(() => {
      setDisliked((current) => wasDisliked ? [...new Set([...current, id])] : current.filter((item) => item !== id))
      setLiked((current) => wasLiked ? [...new Set([...current, id])] : current.filter((item) => item !== id))
      setNftSocial((current) => ({ ...current, [id]: { likes: Math.max(0, (current[id]?.likes ?? 0) + (!wasDisliked && wasLiked ? 1 : 0)), dislikes: Math.max(0, (current[id]?.dislikes ?? 0) + (wasDisliked ? 1 : -1)) } }))
      notify('Reaction could not be saved. Check your connection and try again.')
    })
  }
  const handleFeedNftLike = (id: string) => {
    setDisliked((current) => current.filter((item) => item !== id))
    toggleLike(id)
  }
  const toggleSubscription = (collection: Collection) => {
    const following = subscribedCollections.includes(collection.id)
    setSubscribedCollections((current) => following ? current.filter((id) => id !== collection.id) : [...current, collection.id])
    if (stellarWallet) void toggleSubscriptionRemote(stellarWallet.address, collection.id).catch(() => notify('Follow saved locally; server sync is unavailable'))
    if (!following) {
      const nowIso = new Date().toISOString()
      setNotifications((current) => [
        { id: 0, kind: 'subscription', title: `Following ${collection.name}`, body: 'New drops will appear in your feed.', read_at: null, created_at: nowIso },
        ...current,
      ].slice(0, 12))
      notify(`You’ll be notified when ${collection.name} drops`)
    } else notify(`Unfollowed ${collection.name}`)
  }
  const addComment = async (itemId: string, text: string, parentId: number | string | null = null) => {
    const value = text.trim()
    if (!value) return
    if (!stellarWallet) { notify('Connect your Stellar wallet to comment'); return }
    const temporaryId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setComments((current) => ({ ...current, [itemId]: [...(current[itemId] ?? []), { id: temporaryId, wallet_address: stellarWallet?.address ?? 'Collector', body: value, parent_id: parentId, created_at: new Date().toISOString() }] }))
    {
      const serverParent = parentId !== null && /^\d+$/.test(String(parentId)) ? Number(parentId) : null
      try {
        const result = await postCommentRemote(stellarWallet.address, itemId, value, serverParent)
        setComments((current) => ({ ...current, [itemId]: (current[itemId] ?? []).map((comment) => comment.id === temporaryId ? { ...comment, id: result.id, parent_id: result.parentId } : comment).map((comment) => comment.parent_id === temporaryId ? { ...comment, parent_id: result.id } : comment) }))
      } catch {
        setComments((current) => ({ ...current, [itemId]: (current[itemId] ?? []).filter((comment) => comment.id !== temporaryId) }))
        notify('Comment could not be saved. Check your connection and try again.')
      }
    }
    notify('Comment added')
  }
  const handleSell = (item: NFT) => {
    if (!stellarWallet) { openWallet(item, 'sell'); return }
    if (!ownedItems.some((owned) => owned.id === item.id)) {
      notify(`You don’t own ${item.title} in this wallet`)
      return
    }
    openWallet(item, 'sell')
  }

  const handlePostLike = (postId: number) => {
    if (!stellarWallet) { notify('Connect your Stellar wallet to like posts'); return }
    const wasLiked = posts.find((post) => post.id === postId)?.liked ?? false
    setPosts((current) => current.map((post) => post.id === postId ? { ...post, liked: !post.liked, likes: post.likes + (post.liked ? -1 : 1) } : post))
    if (postId > 0) void togglePostLike(stellarWallet.address, postId).catch(() => {
      setPosts((current) => current.map((post) => post.id === postId ? { ...post, liked: wasLiked, likes: Math.max(0, post.likes + (wasLiked ? 1 : -1)) } : post))
      notify('Like could not be saved. Check your connection and try again.')
    })
  }
  const handleFeedPostLike = (postId: number) => {
    const wasDisliked = disliked.includes(`post:${postId}`)
    setDisliked((current) => current.filter((id) => id !== `post:${postId}`))
    if (wasDisliked) setPosts((current) => current.map((post) => post.id === postId ? { ...post, dislikes: Math.max(0, (post.dislikes ?? 0) - 1) } : post))
    handlePostLike(postId)
  }
  const handlePostDislike = (postId: number) => {
    if (!stellarWallet) { notify('Connect your Stellar wallet to react to posts'); return }
    const key = `post:${postId}`
    const wasDisliked = disliked.includes(key)
    const postBefore = posts.find((item) => item.id === postId)
    const wasLiked = postBefore?.liked ?? false
    const likesBefore = postBefore?.likes ?? 0
    const dislikesBefore = postBefore?.dislikes ?? 0
    setDisliked((current) => wasDisliked ? current.filter((id) => id !== key) : [...current, key])
    setPosts((current) => current.map((post) => post.id === postId ? {
      ...post,
      liked: wasDisliked ? post.liked : false,
      likes: !wasDisliked && post.liked ? Math.max(0, post.likes - 1) : post.likes,
      dislikes: Math.max(0, (post.dislikes ?? 0) + (wasDisliked ? -1 : 1)),
    } : post))
    if (postId > 0) void togglePostDislike(stellarWallet.address, postId).catch(() => {
      setDisliked((current) => wasDisliked ? [...new Set([...current, key])] : current.filter((id) => id !== key))
      setPosts((current) => current.map((post) => post.id === postId
        ? { ...post, liked: wasLiked, likes: likesBefore, dislikes: dislikesBefore }
        : post))
      notify('Reaction could not be saved. Check your connection and try again.')
    })
  }

  const handlePostComment = async (postId: number, text: string, parentId: number | string | null = null) => {
    const value = text.trim()
    if (!value) return
    if (!stellarWallet) { notify('Connect your Stellar wallet to comment'); return }
    const temporaryId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setPosts((current) => current.map((post) => post.id === postId ? { ...post, comments: [...(post.comments ?? []), { id: temporaryId, wallet_address: stellarWallet?.address ?? 'Collector', body: value, parent_id: parentId, created_at: new Date().toISOString() }] } : post))
    if (postId > 0) {
      const serverParent = parentId !== null && /^\d+$/.test(String(parentId)) ? Number(parentId) : null
      try {
        const result = await postToPost(stellarWallet.address, postId, value, serverParent)
        setPosts((current) => current.map((post) => post.id === postId ? { ...post, comments: post.comments.map((comment) => comment.id === temporaryId ? { ...comment, id: result.id, parent_id: result.parentId } : comment).map((comment) => comment.parent_id === temporaryId ? { ...comment, parent_id: result.id } : comment) } : post))
      } catch {
        setPosts((current) => current.map((post) => post.id === postId ? { ...post, comments: post.comments.filter((comment) => comment.id !== temporaryId) } : post))
        notify('Comment could not be saved. Check your connection and try again.')
      }
    }
  }

  const handleTipPost = async (postId: number, recipient: string, amount: string, onProgress: (stage: 'preparing' | 'awaiting-wallet' | 'confirming') => void) => {
    if (!stellarWallet) { openWallet(); throw new Error('Connect your Stellar wallet, then press Tip again.') }
    onProgress('preparing')
    const payment = await sendXlmTip(stellarWallet, recipient, postId, amount, onProgress)
    let count: number | undefined
    let total: string | undefined
    try {
      const recorded = await recordPostTip(stellarWallet.address, postId, payment.hash)
      count = recorded.tipsCount
      total = recorded.tipsTotalXlm
    } catch {
      notify('Tip confirmed on Stellar. Its total is still syncing; the transaction is linked below.')
    }
    setPosts((current) => current.map((post) => post.id === postId ? {
      ...post,
      tips_count: count ?? (post.tips_count ?? 0) + 1,
      tips_total_xlm: total ?? (Number(post.tips_total_xlm ?? 0) + Number(payment.amount)).toFixed(7).replace(/0+$/, '').replace(/\.$/, ''),
    } : post))
    return { hash: payment.hash, amount: payment.amount, tipsCount: count }
  }

  const handleCollectionReaction = async (collectionId: string, reaction: 'like' | 'dislike') => {
    if (!stellarWallet) { notify(`Connect your Stellar wallet to ${reaction} collections`); openWallet(); return }
    try {
      if (reaction === 'like') await toggleCollectionLike(stellarWallet.address, collectionId)
      else await toggleCollectionDislike(stellarWallet.address, collectionId)
      const [row] = await fetchCollectionSocial([collectionId], stellarWallet.address)
      if (row) setCollectionSocial((current) => ({ ...current, [collectionId]: row }))
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save your collection reaction') }
  }

  const handleCollectionComment = async (collectionId: string, text: string, parentId: number | string | null = null) => {
    const body = text.trim()
    if (!body) return
    if (!stellarWallet) { notify('Connect your Stellar wallet to comment'); openWallet(); return }
    try {
      const serverParent = parentId !== null && /^\d+$/.test(String(parentId)) ? Number(parentId) : null
      await commentOnCollection(stellarWallet.address, collectionId, body, serverParent)
      const [row] = await fetchCollectionSocial([collectionId], stellarWallet.address)
      if (row) setCollectionSocial((current) => ({ ...current, [collectionId]: row }))
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not post your comment') }
  }


  const handleCreatorFollow = (creatorId: string) => {
    const following = creatorFollows.includes(creatorId)
    setCreatorFollows((current) => following ? current.filter((id) => id !== creatorId) : [...current, creatorId])
    const creator = creatorFor(creatorId, creatorProfiles)
    notify(following ? `Unfollowed ${creator.name}` : `You followed ${creator.name}`)
    if (stellarWallet) void toggleCreatorFollow(stellarWallet.address, creatorId).then((result) => {
    }).catch(() => notify('Follow saved locally; server sync unavailable'))
  }

  const savePublicProfile = async (input: { displayName: string; creatorUsername: string; bio: string; avatar: string; avatarFile: File | null }) => {
    if (!stellarWallet) throw new Error('Connect a wallet before editing your profile.')
    let avatar = input.avatar
    if (input.avatarFile) {
      const uploaded = await uploadMedia(input.avatarFile, 'profile', { walletAddress: stellarWallet.address })
      avatar = uploaded.original.r2Url ?? uploaded.original.cloudinaryUrl ?? ''
      if (!avatar) throw new Error('The photo upload did not return a public image URL.')
    }
    await updateProfile(stellarWallet.address, {
      displayName: input.displayName,
      creatorUsername: input.creatorUsername,
      bio: input.bio,
      avatar,
    })
    const data = await fetchAccount(stellarWallet.address)
    setAccount(data.account)
    const walletId = stellarWallet.address.toLowerCase()
    setCreatorProfiles((current) => ({
      ...current,
      [walletId]: {
        ...creatorFor(stellarWallet.address, current),
        name: input.creatorUsername ? `@${input.creatorUsername}` : data.account?.display_name?.trim() || 'Stellar creator',
        avatar,
        bio: input.bio || 'Creator on Stellar',
        handle: '',
      },
    }))
    await loadPosts()
    notify(input.creatorUsername ? `Profile saved · @${input.creatorUsername}` : 'Profile saved')
  }

  const handleCreatePost = async () => {
    if (!stellarWallet) { notify('Connect your Stellar wallet to post'); return }
    const linkedNft = ownedItems.find((item) => item.id === composeNft)
    if (!linkedNft && !composeFile && !composeText.trim()) { notify('Add artwork or a caption before sharing'); return }
    setPosting(true)
    try {
      let mediaUrl = ''
      if (composeFile) {
        const uploaded = await uploadMedia(composeFile, undefined, { walletAddress: stellarWallet.address })
        mediaUrl = uploaded.original.r2Url ?? uploaded.original.cloudinaryUrl ?? ''
        if (!mediaUrl) throw new Error('The media upload did not return a public URL')
      }
      const { id } = await createPost(stellarWallet.address, { caption: composeText.trim(), mediaUrl, mediaType: composeFile?.type.startsWith('video/') ? 'video' : 'image', linkedNftId: linkedNft?.id ?? null })
      const author = stellarWallet.address
      setPosts((current) => [{ id, author, author_name: account?.creator_username ? `@${account.creator_username}` : account?.display_name?.trim() || 'Creator', avatar: account?.avatar || '', media_url: mediaUrl || linkedNft?.image || '', media_type: composeFile?.type.startsWith('video/') ? 'video' : 'image', caption: composeText.trim(), linked_nft_id: linkedNft?.id ?? null, post_kind: 'post', author_type: 'user', collection_id: null, price_xlm: null, created_at: new Date().toISOString(), likes: 0, reposts: 0, comments: [], liked: false, reposted: false, tip_recipient: mediaUrl && !linkedNft ? author : null, tips_count: 0, tips_total_xlm: '0' }, ...current])
      setComposeOpen(false)
      setComposeText('')
      setComposeNft('')
      setComposeFile(null)
      notify(linkedNft ? 'Artwork shared to your feed' : 'Art shared to your feed')
      trackProductEvent('post_published', { destination: linkedNft ? 'nft' : 'art' })
    } catch (error) { notify(error instanceof Error ? error.message : 'Unable to post') }
    finally { setPosting(false) }
  }

  const handleCreateCollectionPost = async (collection: Collection, caption: string, mediaUrl: string) => {
    if (!stellarWallet) { notify('Sign in to post as this collection'); return }
    if (!caption.trim() && !mediaUrl.trim()) { notify('Add a caption or media to post'); return }
    try {
      const { id } = await createPost(stellarWallet.address, { caption: caption.trim(), mediaUrl: mediaUrl.trim(), collectionId: collection.id })
      setPosts((current) => [{ id, author: stellarWallet.address, author_name: collection.name, avatar: collection.cover, media_url: mediaUrl.trim(), media_type: 'image', caption: caption.trim(), linked_nft_id: null, post_kind: 'post', author_type: 'collection', collection_id: collection.id, price_xlm: null, created_at: new Date().toISOString(), likes: 0, reposts: 0, comments: [], liked: false, reposted: false }, ...current])
      notify(`Posted as ${collection.name}`)
      trackProductEvent('post_published', { destination: 'collection' })
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Unable to post as this collection')
    }
  }

  const handleCreateCollectionStory = async (collection: Collection, caption: string, mediaUrl: string) => {
    if (!stellarWallet) throw new Error('Sign in to publish a collection story')
    try {
      const video = /\.(mp4|webm|mov)(\?.*)?$/i.test(mediaUrl.trim())
      await createCollectionStory(stellarWallet.address, collection.id, { caption: caption.trim(), mediaUrl: mediaUrl.trim(), mediaType: video ? 'video' : 'image' })
      const { groups } = await fetchCollectionStories(stellarWallet.address)
      setStoryGroups(groups)
      notify(`${collection.name} story is live for 24 hours`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Unable to share this story')
      throw error
    }
  }

  const handleCreateCreatorStory = async (caption: string, mediaUrl: string, mediaType: 'image' | 'video') => {
    if (!stellarWallet) throw new Error('Sign in to publish your status')
    await createCreatorStory(stellarWallet.address, { caption: caption.trim(), mediaUrl: mediaUrl.trim(), mediaType })
    const { groups } = await fetchCollectionStories(stellarWallet.address)
    setStoryGroups(groups)
    notify('Your status is live for 24 hours')
  }

  const handleConnectWallet = async () => {
    if (privyAuth.configured) {
      if (!privyAuth.ready) return
      try {
        await privyAuth.login()
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Email sign-in could not be opened')
      }
      return
    }
    await handleConnectFreighter()
  }

  const handleConnectFreighter = async () => {
    try {
      const wallet = await connectFreighter()
      await authenticateWallet(wallet)
      setStellarWallet(wallet)
      if (!walletItem) setWalletOpen(false)
      notify(`${shortenStellarAddress(wallet.address)} signed in on ${wallet.network === 'PUBLIC' ? 'Stellar Mainnet' : 'Stellar Testnet'}`)
      try {
        const data = await fetchAccount(wallet.address)
        setAccount(data.account)
        setWalletCollections(data.collections)
      } catch { /* account read is best-effort */ }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Unable to connect a Stellar wallet')
    }
  }

  const handleDisconnectWallet = async () => {
    if (stellarWallet) await clearWalletSession(stellarWallet.address)
    if (stellarWallet?.provider === 'Privy') await privyAuth.logout()
    setStellarWallet(null)
    setAccount(null)
    setWalletCollections([])
    setWalletOpen(false)
    notify('Wallet disconnected')
  }

  const openCollectionCreation = () => {
    if (collectionCreating) return
    setOnboardName('')
    setOnboardSymbol('')
    setOnboardDesc('')
    setOnboardSupply('')
    setOnboardCover(null)
    setOnboardingOpen(true)
  }

  const closeCollectionCreation = () => {
    if (collectionCreating) return
    setOnboardingOpen(false)
    setOnboardName('')
    setOnboardSymbol('')
    setOnboardDesc('')
    setOnboardSupply('444')
    setOnboardCover(null)
  }

  const handleCreateMyCollection = async () => {
    if (collectionCreating) return
    if (!stellarWallet) { notify('Connect your Stellar wallet first'); return }
    if (!onboardName.trim() || !onboardSymbol.trim()) { notify('Enter a collection name and symbol'); return }
    if (!onboardCover) { notify('Choose a display image for your collection'); return }
    const totalSupply = onboardSupply.trim() ? Number(onboardSupply) : null
    if (totalSupply !== null && (!Number.isSafeInteger(totalSupply) || totalSupply < 1 || totalSupply > 10000000)) { notify('Enter a valid total supply from 1 to 10,000,000, or leave it open'); return }
    setCollectionCreating(true)
    try {
      const contractId = getSorobanNftContractId()
      // The collection API requires the NFT contract to be registered first.
      await registerNftContract(stellarWallet.address, contractId)
      const uploadedCover = await uploadMedia(onboardCover, onboardSymbol.trim() || onboardName.trim(), { walletAddress: stellarWallet.address })
      const cover = uploadedCover.original.r2Url ?? uploadedCover.original.cloudinaryUrl
      if (!cover) throw new Error('The collection image upload did not return a public URL')
      const data = await createCollection(stellarWallet.address, { name: onboardName.trim(), symbol: onboardSymbol.trim(), description: onboardDesc.trim(), cover, totalSupply, contractId })
      trackProductEvent('collection_created', { flow: 'manual' })
      setAccount((current) => current ? { ...current, is_creator: true } : { wallet_address: stellarWallet.address, display_name: onboardName.trim(), creator_username: '', avatar: '', bio: '', is_creator: true, is_admin: false, is_verified: false })
      const createdCollection: Collection = { id: data.slug, name: onboardName.trim(), symbol: onboardSymbol.trim(), creatorId: stellarWallet.address, cover, floor: '—', volume: '—', items: '0', change: '—', description: onboardDesc.trim(), contractId: data.contractId, totalSupply }
      setWalletCollections((current) => [...current, { id: data.id, slug: data.slug, name: createdCollection.name, symbol: createdCollection.symbol, description: createdCollection.description, cover, contract_id: data.contractId, total_supply: totalSupply }])
      setAllCollections((current) => [createdCollection, ...current.filter((collection) => collection.id !== data.slug)])
      setOnboardingOpen(false)
      setOnboardName('')
      setOnboardSymbol('')
      setOnboardDesc('')
      setOnboardSupply('')
      setOnboardCover(null)
      setView('collections')
      setDetail({ type: 'collection', item: createdCollection })
      setMintTargetCollectionSlug(data.slug)
      setFirstCollectionMintStep(true)
      setMintTitle('')
      setMintDescription('')
      setMintFile(onboardCover)
      setMintArtworkUrl('')
      setMintMediaFile(null)
      setMintTraits('')
      setMintError('')
      setMintSuccess(null)
      setMintOpen(true)
      notify(`${createdCollection.name} is ready. Add your first NFT to the collection.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not create your collection')
    } finally {
      setCollectionCreating(false)
    }
  }

  const createUnrevealedPlaceholder = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create the unrevealed collection image')
    const gradient = context.createLinearGradient(0, 0, 512, 512)
    gradient.addColorStop(0, '#7c3aed')
    gradient.addColorStop(1, '#ec4899')
    context.fillStyle = '#10101a'
    context.fillRect(0, 0, 512, 512)
    context.globalAlpha = 0.8
    context.fillStyle = gradient
    context.beginPath()
    context.arc(256, 215, 112, 0, Math.PI * 2)
    context.fill()
    context.globalAlpha = 1
    context.fillStyle = '#fff'
    context.beginPath()
    for (let point = 0; point < 10; point += 1) {
      const radius = point % 2 === 0 ? 92 : 40
      const angle = -Math.PI / 2 + point * Math.PI / 5
      const x = 256 + Math.cos(angle) * radius
      const y = 215 + Math.sin(angle) * radius
      point === 0 ? context.moveTo(x, y) : context.lineTo(x, y)
    }
    context.closePath()
    context.fill()
    context.textAlign = 'center'
    context.fillStyle = '#fff'
    context.font = '600 25px Arial, sans-serif'
    context.fillText('UNREVEALED', 256, 390)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not encode the unrevealed collection image')
    return new File([blob], 'unrevealed.png', { type: 'image/png' })
  }

  const createAiStudioCollection = async (input: { name: string; symbol: string; description: string; totalSupply: number; cover: File }) => {
    if (!stellarWallet) throw new Error('Connect your Stellar wallet before creating a collection')
    const contractId = getSorobanNftContractId()
    await registerNftContract(stellarWallet.address, contractId)
    const symbol = input.symbol.trim().toUpperCase()
    // If an earlier attempt created the collection but failed while attaching
    // its unrevealed metadata, reuse that same placeholder-backed collection.
    const existingCollections = await fetchAccount(stellarWallet.address).then((data) => data.collections).catch(() => [])
    const recovered = existingCollections.find((item) => item.name === input.name && item.symbol === symbol && item.total_supply === input.totalSupply && item.contract_id === contractId)
    let cover = recovered?.cover
    if (!cover) {
      const placeholderFile = await createUnrevealedPlaceholder()
      const coverUpload = await uploadMedia(placeholderFile, symbol, { walletAddress: stellarWallet.address })
      cover = coverUpload.original.r2Url ?? coverUpload.original.cloudinaryUrl ?? ''
      if (!cover) throw new Error('Could not upload the unrevealed collection placeholder')
    }
    const created = recovered
      ? { id: recovered.id, slug: recovered.slug, contractId: recovered.contract_id ?? contractId, totalSupply: recovered.total_supply ?? input.totalSupply, isCreator: true }
      : await createCollection(stellarWallet.address, { name: input.name, symbol, description: input.description, cover, totalSupply: input.totalSupply, contractId })
    trackProductEvent('collection_created', { flow: 'ai-studio' })
    const placeholderMetadata = await uploadCreatorMetadata(stellarWallet.address, created.slug, { name: `${input.name} — Unrevealed`, description: 'Artwork has not been revealed yet.', image: cover, attributes: [] })
    if (!placeholderMetadata.url) throw new Error('Collection created, but its unrevealed placeholder metadata could not be created.')
    await updateCollectionReveal(stellarWallet.address, created.slug, { revealed: false, placeholderUri: placeholderMetadata.url })
    try { await setCreatorReveal(stellarWallet, contractId, { collectionScope: created.slug, revealed: false, placeholderUri: placeholderMetadata.url }) }
    catch (error) {
      await updateCollectionReveal(stellarWallet.address, created.slug, { revealed: true }).catch(() => undefined)
      throw new Error(`Collection created, but the unrevealed state could not be confirmed on-chain: ${error instanceof Error ? error.message : 'wallet transaction failed'}`)
    }
    const collection: Collection = { id: created.slug, name: input.name, symbol, creatorId: stellarWallet.address, cover, floor: '—', volume: '—', items: '0', change: '—', description: input.description, contractId: created.contractId, totalSupply: input.totalSupply }
    setAccount((current) => current ? { ...current, is_creator: true } : { wallet_address: stellarWallet.address, display_name: input.name, creator_username: '', avatar: '', bio: '', is_creator: true, is_admin: false, is_verified: false })
    setWalletCollections((current) => [...current, { id: created.id, slug: created.slug, name: input.name, symbol, description: input.description, cover, contract_id: created.contractId, total_supply: input.totalSupply }])
    setAllCollections((current) => [collection, ...current.filter((item) => item.id !== created.slug)])
    return created.slug
  }

  const saveAiStudioArtwork = async (slug: string, assets: TransferAsset[], rarityMix: { high: number; medium: number; common: number }, onProgress: (message: string) => void) => {
    if (!stellarWallet) throw new Error('Connect your creator wallet to save collection artwork')
    if (!assets.length) throw new Error('Select at least one generated artwork')
    const artwork: CollectionDropDraft['artwork'] = []
    for (const [index, asset] of assets.entries()) {
      onProgress(`Uploading artwork ${index + 1} of ${assets.length}…`)
      const extension = asset.file.type === 'image/jpeg' ? 'jpg' : asset.file.type === 'image/webp' ? 'webp' : asset.file.type === 'image/gif' ? 'gif' : 'png'
      const file = new File([asset.file], `${slug}-${index + 1}.${extension}`, { type: asset.file.type || 'image/png' })
      const media = await uploadMedia(file, slug, { walletAddress: stellarWallet.address })
      const image = media.original.r2Url ?? media.original.cloudinaryUrl
      if (!image) throw new Error(`Could not upload ${asset.name}`)
      let animationUrl: string | undefined
      if (asset.animation) {
        const animation = await uploadMedia(new File([asset.animation], `${slug}-${index + 1}.gif`, { type: 'image/gif' }), slug, { walletAddress: stellarWallet.address })
        animationUrl = animation.original.r2Url ?? animation.original.cloudinaryUrl ?? undefined
        if (!animationUrl) throw new Error(`Could not upload the animation for ${asset.name}`)
      }
      artwork.push({ id: `ai-${index + 1}`, name: asset.name, description: asset.description, image, animation_url: animationUrl, attributes: asset.attributes, rarityScore: asset.rarityScore })
    }
    const raritySeed = crypto.getRandomValues(new Uint32Array(1))[0]
    const saved: CollectionDropDraft = { startTime: '', artwork, stages: [], allowlists: {}, rarityMix, raritySeed, masterArtworkExpansion: true, stageIds: {}, stageContractId: getSorobanNftContractId() }
    await saveCollectionDropDraft(stellarWallet.address, slug, saved)
    window.dispatchEvent(new CustomEvent('nftgram:refresh-collection', { detail: { collectionId: slug } }))
    notify('Artwork saved. Opening collection settings…')
  }

  // Mint a brand-new NFT on-chain (SEP-50 contract), then record its metadata
  // in the read model and map it into a collection so it can be listed/resold.
  const handleMintNft = async (draft?: StudioMintInput, collectionSlugOverride?: string) => {
    if (minting) return
    if (!stellarWallet) { notify('Connect your Stellar wallet to mint'); return }
    const title = typeof draft?.title === 'string' ? draft.title.trim() : mintTitle.trim()
    const description = typeof draft?.description === 'string' ? draft.description : mintDescription
    const artworkFile = draft?.artwork ?? mintFile
    const artworkUrl = draft ? '' : mintArtworkUrl.trim()
    const animationFile = draft?.animation ?? mintMediaFile
    const traitText = typeof draft?.traits === 'string' ? draft.traits : mintTraits
    if (!title) { notify('Give your NFT a title'); return }
    if (!artworkFile && !artworkUrl) { notify('Choose artwork or add an image URL'); return }
    setMintError('')
    const collectionSlug = draft?.collectionId || collectionSlugOverride || ''
    const mintScope = collectionSlug || `personal-${stellarWallet.address.toLowerCase()}`
    const targetCollection = collectionSlug ? walletCollections.find((collection) => collection.slug === collectionSlug) : null
    if (collectionSlug && !targetCollection) {
      setMintError('Choose a collection owned by this wallet, or mint as a standalone NFT.')
      return
    }
    if (targetCollection && !targetCollection.contract_id) {
      setMintError('This collection is missing its registered NFT contract. Choose another collection or mint as standalone.')
      return
    }
    const contractId = targetCollection?.contract_id || getSorobanNftContractId()
    if (!contractId) { setMintError('The Stellar NFT contract is not configured.'); notify('The Stellar NFT contract is not configured'); return }
    setMinting(true)
    try {
      const media = artworkFile ? await uploadMedia(artworkFile, mintScope, { walletAddress: stellarWallet.address }) : null
      const image = media ? (media.original.r2Url ?? media.original.cloudinaryUrl) : artworkUrl
      if (!image) throw new Error('The artwork upload did not return a public URL')
      const animation = animationFile ? await uploadMedia(animationFile, mintScope, { walletAddress: stellarWallet.address }) : null
      const animationUrl = animation?.original.r2Url ?? animation?.original.cloudinaryUrl ?? undefined
      const metadata = await uploadCreatorMetadata(stellarWallet.address, mintScope, {
        name: title, description: description.trim(), image, animation_url: animationUrl, attributes: parseTraits(traitText),
        creation_method: draft?.provenanceSource ?? 'quick-mint',
      })
      if (!metadata.url) throw new Error('Metadata storage did not return a public URL')
      const { tokenId, hash } = await mintNftWithMetadata(stellarWallet, contractId, mintScope, metadata.url)
      if (tokenId === null) throw new Error(`Mint transaction ${hash} confirmed but did not return a token id`)
      // Chain confirmation completes the mint. Metadata indexing is separate
      // background work and must not hold the Mint button or block a later mint.
      // The recipient is the connected wallet, so reflect confirmed ownership
      // immediately instead of waiting for the indexer before enabling sharing.
      setOwnedTokens((current) => current.some((token) => token.contract_id.toLowerCase() === contractId.toLowerCase() && token.token_id === tokenId)
        ? current
        : [...current, { contract_id: contractId, token_id: tokenId }])
      setOwnershipSource('indexed')
      setMintSuccess({ tokenId, title, image, contractId, txHash: hash, indexed: false })
      trackProductEvent('mint_confirmed', { flow: collectionSlug ? 'collection' : 'standalone', network: stellarWallet.network === 'PUBLIC' ? 'mainnet' : 'testnet', quantity: 1 })
      const indexing = recordMintedNft(stellarWallet.address, {
        tokenId,
        collectionId: mintScope,
        contractId,
        title,
        image,
        metadataUri: metadata.url,
        txHash: hash,
      })
      setPendingMintInputs(getPendingMintRecords(stellarWallet.address))
      void indexing.then(async () => {
        setMintSuccess((current) => current?.tokenId === tokenId && current.contractId === contractId ? { ...current, indexed: true } : current)
        setMintedNfts(await fetchMintedNfts())
        setPendingMintInputs(getPendingMintRecords(stellarWallet.address))
        const owned = await fetchOwnedNfts(stellarWallet.address)
        setOwnedTokens(owned.map(({ contract_id, token_id }) => ({ contract_id, token_id })))
        setOwnershipSource('indexed')
      }).catch(() => {
        // recordMintedNft keeps the confirmed token queued for safe background retry.
      })
      notify(`Minted #${tokenId} · ${title} is on Stellar Testnet`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Minting failed'
      setMintError(message)
      notify(message)
    } finally {
      setMinting(false)
    }
  }

  const generateAiArtwork = async (prompt: string, transparent = false) => {
    if (!stellarWallet) throw new Error('Connect your wallet before generating artwork.')
    trackProductEvent('artwork_generation_started', { studio: 'ai-art' })
    try {
    const response = await fetch('/api/ai/generate-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(stellarWallet.address) },
      body: JSON.stringify({ prompt, transparent }),
    })
    const result = await response.json().catch(() => null) as { image?: string; error?: string } | null
    if (!response.ok || !result?.image) throw new Error(result?.error ?? 'Could not generate artwork.')
    const image = await fetch(result.image).then((item) => item.blob())
    const contentType = image.type || 'image/jpeg'
    const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
    trackProductEvent('artwork_generation_completed', { studio: 'ai-art', result: 'success' })
    return new File([image], `ai-artwork.${extension}`, { type: contentType })
    } catch (error) {
      trackProductEvent('artwork_generation_failed', { studio: 'ai-art', result: 'failed' })
      throw error
    }
  }

  const analyzeAiArtwork = async (file: File) => {
    if (!stellarWallet) throw new Error('Connect your wallet before analyzing artwork.')
    const form = new FormData()
    form.append('image', file, file.name)
    const response = await fetch('/api/ai/analyze-image', {
      method: 'POST',
      headers: authHeaders(stellarWallet.address),
      body: form,
    })
    const result = await response.json().catch(() => null) as { attributes?: { trait_type: string; value: string }[]; error?: string } | null
    if (!response.ok || !Array.isArray(result?.attributes)) throw new Error(result?.error ?? 'Could not analyze artwork traits.')
    return result.attributes
  }

  const verifyAiArtworkTraits = async (file: File, expectedAttributes: { trait_type: string; value: string }[]) => {
    if (!stellarWallet) throw new Error('Connect your wallet before checking artwork traits.')
    const form = new FormData()
    form.append('image', file, file.name)
    form.append('expectedAttributes', JSON.stringify(expectedAttributes))
    const response = await fetch('/api/ai/verify-collection-artwork', {
      method: 'POST',
      headers: authHeaders(stellarWallet.address),
      body: form,
    })
    const result = await response.json().catch(() => null) as { checks?: { trait_type: string; expected: string; status: 'visible' | 'missing' | 'uncertain'; observed?: string; note?: string }[]; summary?: string; error?: string } | null
    if (!response.ok || !Array.isArray(result?.checks)) throw new Error(result?.error ?? 'Could not verify the assigned traits.')
    return result
  }

  const planAiCollectionTraits = async (prompt: string, count: number) => {
    if (!stellarWallet) throw new Error('Connect your wallet before planning collection traits.')
    const response = await fetch('/api/ai/plan-collection-traits', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(stellarWallet.address) },
      body: JSON.stringify({ prompt, count }),
    })
    const result = await response.json().catch(() => null) as { categories?: { name: string; options: { value: string; weight: number }[] }[]; error?: string } | null
    if (!response.ok || !Array.isArray(result?.categories)) throw new Error(result?.error ?? 'Could not plan collection traits.')
    return result.categories.map((category) => ({ id: crypto.randomUUID(), name: category.name, options: category.options.map((option) => ({ id: crypto.randomUUID(), ...option })) }))
  }

  // Secondary-trading management: cancel a live listing, cancel an outgoing
  // offer, or accept an incoming offer on a token this wallet owns. Each is a
  // real Soroban marketplace invocation signed by the wallet.
  const refreshMarketplace = () => {
    if (!stellarWallet) return
    void fetchMarketplaceState(stellarWallet.address).then(setMarketplace).catch(() => {})
  }

  const handleCancelListing = async (listingId: number, contractId = sorobanMarketplaceConfig.marketplaceContractId) => {
    if (!stellarWallet) { notify('Connect your wallet to manage listings'); return }
    if (!contractId) { notify('The marketplace contract is not configured'); return }
    try {
      const listing = [...activeListings, ...(marketplace?.listings ?? [])].find((entry) => entry.listing_id === listingId && entry.contract_id?.toLowerCase() === contractId.toLowerCase())
      const expired = Boolean(listing && latestLedger >= listing.expires_at)
      await invokeSoroban(contractId, expired ? 'expire_listing' : 'cancel_listing', [
        StellarSdk.nativeToScVal(listingId, { type: 'u32' }),
      ], stellarWallet)
      notify(`Listing #${listingId} ${expired ? 'expired and NFT returned' : 'cancelled'} on Stellar Testnet`)
      refreshMarketplace()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not cancel the listing')
    }
  }

  const handleCancelAuction = async (auctionId: number) => {
    if (!stellarWallet || !sorobanMarketplaceConfig.marketplaceContractId) return notify('Connect your wallet to manage this auction')
    try {
      await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'cancel_auction', [StellarSdk.nativeToScVal(auctionId, { type: 'u32' })], stellarWallet)
      setActiveAuctions((items) => items.filter((auction) => auction.auction_id !== auctionId))
      notify('Auction cancelled and NFT returned to your wallet')
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not cancel this auction') }
  }

  const handleSettleAuction = async (auctionId: number) => {
    if (!stellarWallet || !sorobanMarketplaceConfig.marketplaceContractId) return notify('Connect a wallet to settle this auction')
    try {
      await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'settle_auction', [StellarSdk.nativeToScVal(auctionId, { type: 'u32' })], stellarWallet)
      setActiveAuctions((items) => items.filter((auction) => auction.auction_id !== auctionId))
      refreshMarketplace()
      notify('Auction settled on Stellar')
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not settle this auction') }
  }

  const handleCancelOffer = async (offerId: number, contractId = sorobanMarketplaceConfig.marketplaceContractId) => {
    if (!stellarWallet) { notify('Connect your wallet to manage offers'); return }
    if (!contractId) { notify('The marketplace contract is not configured'); return }
    try {
      const offer = marketplace?.offers.find((entry) => entry.offer_id === offerId && entry.contract_id?.toLowerCase() === contractId.toLowerCase())
      const expired = Boolean(offer && offer.expires_at * 1000 <= Date.now())
      await invokeSoroban(contractId, expired ? 'expire_offer' : 'cancel_offer', [
        StellarSdk.nativeToScVal(offerId, { type: 'u32' }),
      ], stellarWallet)
      notify(`Offer #${offerId} ${expired ? 'expired and escrow refunded' : 'cancelled and refunded'} on Stellar Testnet`)
      refreshMarketplace()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not cancel the offer')
    }
  }

  const handleAcceptOffer = async (offerId: number, contractId = sorobanMarketplaceConfig.marketplaceContractId) => {
    if (!stellarWallet) { notify('Connect your wallet to accept offers'); return }
    if (!contractId) { notify('The marketplace contract is not configured'); return }
    try {
      await invokeSoroban(contractId, 'accept_offer', [
        StellarSdk.nativeToScVal(offerId, { type: 'u32' }),
        StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }),
      ], stellarWallet)
      notify(`Offer #${offerId} accepted — the NFT transferred on Stellar Testnet`)
      // Update the local public NFT read model immediately; the indexer will
      // persist the same new owner for other visitors shortly afterward.
      const acceptedOffer = marketplace?.incomingOffers.find((offer) => offer.offer_id === offerId && offer.contract_id?.toLowerCase() === contractId.toLowerCase())
      setMintedNfts((items) => items.map((item) => item.contract_id.toLowerCase() === acceptedOffer?.nft_contract.toLowerCase()
        && item.token_id === acceptedOffer?.token_id
        ? { ...item, owner_address: acceptedOffer.buyer || item.owner_address, owner_name: undefined }
        : item))
      refreshMarketplace()
      // Ownership likely changed; refresh owned tokens too.
      void fetchOwnedNfts(stellarWallet.address).then((owned) => {
        setOwnedTokens(owned.map(({ contract_id, token_id }) => ({ contract_id, token_id })))
        setOwnershipSource('indexed')
      }).catch(() => {})
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not accept the offer')
    }
  }

  const handleRejectOffer = async (offerId: number, contractId = sorobanMarketplaceConfig.marketplaceContractId) => {
    if (!stellarWallet) return notify('Connect your wallet to reject received offers')
    if (!contractId) return notify('The marketplace contract is not configured')
    try {
      const offer = marketplace?.incomingOffers.find((entry) => entry.offer_id === offerId && entry.contract_id?.toLowerCase() === contractId.toLowerCase())
      const expired = Boolean(offer && offer.expires_at * 1000 <= Date.now())
      const expirePermissionlessly = expired
      await invokeSoroban(contractId, expirePermissionlessly ? 'expire_offer' : 'cancel_offer_by_owner', [
        StellarSdk.nativeToScVal(offerId, { type: 'u32' }),
        ...(!expirePermissionlessly ? [StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' })] : []),
      ], stellarWallet)
      notify(`Offer #${offerId} ${expired ? 'expired' : 'cancelled'}. The buyer's escrow was refunded on Stellar Testnet.`)
      refreshMarketplace()
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not cancel this offer') }
  }

  const handleCounterOffer = async (offerId: number, amount: string, contractId = sorobanMarketplaceConfig.marketplaceContractId) => {
    if (!stellarWallet) { notify('Connect your wallet to counter offers'); return false }
    try {
      await respondToMarketplaceOffer(stellarWallet.address, offerId, 'counter', amount, contractId)
      notify(`Counter-offer sent for offer #${offerId}`)
      refreshMarketplace()
      return true
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not send the counter-offer'); return false }
  }

  const handleCounterResponse = async (offer: MarketplaceOffer, accept: boolean) => {
    if (!stellarWallet) return notify('Connect your wallet to respond to counter-offers')
    const contractId = offer.contract_id ?? sorobanMarketplaceConfig.marketplaceContractId
    if (!accept) {
      try {
        await respondToMarketplaceOffer(stellarWallet.address, offer.offer_id, 'counter-reject', undefined, contractId)
        notify('Counter-offer declined. Cancel the original offer to reclaim its escrow.')
        refreshMarketplace()
      } catch (error) { notify(error instanceof Error ? error.message : 'Could not decline the counter-offer') }
      return
    }
    if (!contractId || !sorobanMarketplaceConfig.paymentToken || !offer.counter_amount) {
      notify('Marketplace counter-offer details are unavailable')
      return
    }
    try {
      await invokeSoroban(contractId, 'replace_offer', [
        StellarSdk.nativeToScVal(offer.offer_id, { type: 'u32' }),
        StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }),
        StellarSdk.nativeToScVal(BigInt(offer.counter_amount), { type: 'i128' }),
      ], stellarWallet)
      await respondToMarketplaceOffer(stellarWallet.address, offer.offer_id, 'counter-accept', undefined, contractId)
      notify('Counter accepted: your original escrow was replaced atomically. The seller must accept the new offer to complete the sale.')
      refreshMarketplace()
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not accept this counter-offer') }
  }

  const handleOnChainAction = async (amount?: string, durationHours?: string, minIncrementXlm?: string, selectedPaymentToken?: string) => {
    if (!stellarWallet || !walletItem) return
    setWalletActionStatus('preparing')
    setWalletActionError('')
    try {
      const tokenId = walletItem.tokenId ?? null
      const paymentToken = selectedPaymentToken || sorobanMarketplaceConfig.paymentToken
      const activeListing = activeListings.find((listing) => listing.nft_contract.toLowerCase() === walletItem.contractId?.toLowerCase() && listing.token_id === tokenId)
      const listingId = activeListing?.listing_id ?? null
      const nftContractId = walletItem.contractId ?? sorobanMarketplaceConfig.nftContractId
      if (walletMode === 'auction') {
        if (!sorobanMarketplaceConfig.marketplaceContractId || !paymentToken) throw new Error('The Stellar marketplace is not configured')
        if (tokenId === null || !nftContractId) throw new Error('This NFT has no indexed Stellar token ID')
        const hours = Number(durationHours ?? '24')
        if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error('Choose an auction duration from 1 hour to 30 days')
        const asset = stellarPaymentAssets.find((entry) => entry.contractId === paymentToken) ?? stellarPaymentAssets[0]
        const reserve = assetAmountToUnits(amount ?? '0', asset.decimals)
        if (reserve <= 0n) throw new Error(`Enter a reserve price greater than 0 ${asset.code}`)
        const minIncrement = assetAmountToUnits(minIncrementXlm ?? '0.01', asset.decimals)
        if (minIncrement < 0n) throw new Error('Minimum bid increment cannot be negative')
        const latest = await sorobanServer.getLatestLedger()
        const startsAt = latest.sequence + 1
        const endsAt = startsAt + hours * 720
        await invokeSoroban(nftContractId, 'approve', [
          StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }),
          StellarSdk.nativeToScVal(sorobanMarketplaceConfig.marketplaceContractId, { type: 'address' }),
          StellarSdk.nativeToScVal(tokenId, { type: 'u32' }),
          StellarSdk.nativeToScVal(endsAt + 1000, { type: 'u32' }),
        ], stellarWallet, (stage) => setWalletActionStatus(stage))
        setWalletActionStatus('preparing')
        const result = await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'create_auction', [
          StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }),
          StellarSdk.nativeToScVal(nftContractId, { type: 'address' }),
          StellarSdk.nativeToScVal(tokenId, { type: 'u32' }),
          StellarSdk.nativeToScVal(paymentToken, { type: 'address' }),
          StellarSdk.nativeToScVal(reserve, { type: 'i128' }),
          StellarSdk.nativeToScVal(minIncrement, { type: 'i128' }),
          StellarSdk.nativeToScVal(startsAt, { type: 'u32' }),
          StellarSdk.nativeToScVal(endsAt, { type: 'u32' }),
        ], stellarWallet, (stage) => setWalletActionStatus(stage))
        const auctionId = Number(result.rawReturnValue ? StellarSdk.scValToNative(result.rawReturnValue) : NaN)
        if (Number.isSafeInteger(auctionId)) setActiveAuctions((items) => [...items, { auction_id: auctionId, seller: stellarWallet.address, nft_contract: nftContractId, token_id: tokenId, payment_token: paymentToken!, reserve_price: reserve.toString(), min_increment: minIncrement.toString(), highest_bid: '0', highest_bidder: null, starts_at: startsAt, ends_at: endsAt, active: true, ledger: 0 }])
        setWalletActionStatus('complete')
        trackProductEvent('marketplace_action_confirmed', { flow: 'create-auction', network: stellarWallet.network === 'PUBLIC' ? 'mainnet' : 'testnet' })
        notify(`${walletItem.title} auction is live on Stellar`)
        return
      }
      if (walletMode === 'bid') {
        if (!walletAuction || !sorobanMarketplaceConfig.marketplaceContractId) throw new Error('This auction is no longer available. Refresh and try again.')
        const asset = stellarPaymentAssets.find((entry) => entry.contractId === walletAuction.payment_token) ?? stellarPaymentAssets[0]
        const bid = assetAmountToUnits(amount ?? '0', asset.decimals)
        if (bid <= 0n) throw new Error(`Enter a bid greater than 0 ${asset.code}`)
        await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'bid', [
          StellarSdk.nativeToScVal(walletAuction.auction_id, { type: 'u32' }),
          StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }),
          StellarSdk.nativeToScVal(bid, { type: 'i128' }),
        ], stellarWallet, (stage) => setWalletActionStatus(stage))
        setActiveAuctions((items) => items.map((auction) => auction.auction_id === walletAuction.auction_id ? { ...auction, highest_bid: bid.toString(), highest_bidder: stellarWallet.address } : auction))
        setWalletActionStatus('complete')
        trackProductEvent('marketplace_action_confirmed', { flow: 'bid', network: stellarWallet.network === 'PUBLIC' ? 'mainnet' : 'testnet' })
        notify(`Your bid for ${walletItem.title} is confirmed`)
        refreshMarketplace()
        return
      }
      if (walletMode === 'sell' && sorobanMarketplaceConfig.marketplaceContractId && paymentToken) {
        const latest = await sorobanServer.getLatestLedger()
        const asset = stellarPaymentAssets.find((entry) => entry.contractId === paymentToken) ?? stellarPaymentAssets[0]
        const xlm = assetAmountToUnits(amount ?? '0', asset.decimals)
        if (xlm <= 0n) throw new Error(`Enter a sale price greater than 0 ${asset.code}`)
        if (tokenId === null) throw new Error('This NFT has no indexed Stellar Testnet token ID')
        if (!nftContractId) throw new Error('The NFT contract is not configured')
        const expiresAt = latest.sequence + 500_000
        if (listingId !== null) {
          if (listingId < 0) throw new Error('Your listing is still confirming. Refresh the marketplace before editing it.')
          await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'update_listing', [
            StellarSdk.nativeToScVal(listingId, { type: 'u32' }),
            StellarSdk.nativeToScVal(paymentToken, { type: 'address' }),
            StellarSdk.nativeToScVal(xlm, { type: 'i128' }),
            StellarSdk.nativeToScVal(expiresAt, { type: 'u32' }),
          ], stellarWallet, (stage) => setWalletActionStatus(stage))
          setWalletActionStatus('complete')
          trackProductEvent('marketplace_action_confirmed', { flow: 'edit-listing', network: stellarWallet.network === 'PUBLIC' ? 'mainnet' : 'testnet' })
          setActiveListings((current) => current.map((listing) => listing.listing_id === listingId ? { ...listing, payment_token: paymentToken, price: xlm.toString(), expires_at: expiresAt } : listing))
          notify(`${walletItem.title} listing updated on Stellar Testnet`)
          refreshMarketplace()
          return
        }
        await invokeSoroban(nftContractId, 'approve', [
          StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }),
          StellarSdk.nativeToScVal(sorobanMarketplaceConfig.marketplaceContractId, { type: 'address' }),
          StellarSdk.nativeToScVal(tokenId, { type: 'u32' }),
          StellarSdk.nativeToScVal(expiresAt, { type: 'u32' }),
        ], stellarWallet, (stage) => setWalletActionStatus(stage))
        setWalletActionStatus('preparing')
        await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'list', [
          StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }),
          StellarSdk.nativeToScVal(nftContractId, { type: 'address' }),
          StellarSdk.nativeToScVal(tokenId, { type: 'u32' }),
          StellarSdk.nativeToScVal(paymentToken, { type: 'address' }),
          StellarSdk.nativeToScVal(xlm, { type: 'i128' }),
          StellarSdk.nativeToScVal(expiresAt, { type: 'u32' }),
        ], stellarWallet, (stage) => setWalletActionStatus(stage))
        setWalletActionStatus('complete')
        trackProductEvent('marketplace_action_confirmed', { flow: 'list', network: stellarWallet.network === 'PUBLIC' ? 'mainnet' : 'testnet' })
        setActiveListings((current) => [
          ...current.filter((listing) => !(listing.nft_contract.toLowerCase() === nftContractId.toLowerCase() && listing.token_id === tokenId)),
          { listing_id: -Date.now(), seller: stellarWallet.address, nft_contract: nftContractId, token_id: tokenId, payment_token: paymentToken, price: xlm.toString(), expires_at: expiresAt, ledger: 0 },
        ])
        notify(`${walletItem.title} is listed on Stellar Testnet`)
        return
      }
      if (walletMode === 'buy') {
        if (listingId === null) throw new Error('This NFT no longer has an active listing. Refresh the page and try again.')
        if (!sorobanMarketplaceConfig.marketplaceContractId) throw new Error('The marketplace contract is not configured for this network.')
        await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'buy', [
          StellarSdk.nativeToScVal(listingId, { type: 'u32' }),
          StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }),
        ], stellarWallet, (stage) => setWalletActionStatus(stage))
        setWalletActionStatus('complete')
        trackProductEvent('marketplace_action_confirmed', { flow: 'buy', network: stellarWallet.network === 'PUBLIC' ? 'mainnet' : 'testnet' })
        setActiveListings((current) => current.filter((listing) => listing.listing_id !== listingId))
        setMintedNfts((current) => current.map((mint) => mint.contract_id.toLowerCase() === walletItem.contractId?.toLowerCase() && mint.token_id === tokenId
          ? { ...mint, owner_address: stellarWallet.address, owner_name: undefined }
          : mint))
        refreshMarketplace()
        void fetchOwnedNfts(stellarWallet.address).then((owned) => {
          setOwnedTokens(owned.map(({ contract_id, token_id }) => ({ contract_id, token_id })))
          setOwnershipSource('indexed')
        }).catch(() => {})
        return
      }
      if (walletMode === 'offer' && sorobanMarketplaceConfig.marketplaceContractId && paymentToken) {
        if (tokenId === null) throw new Error('This NFT has no indexed Stellar Testnet token ID')
        if (!nftContractId) throw new Error('The NFT contract is not configured')
        const asset = stellarPaymentAssets.find((entry) => entry.contractId === paymentToken) ?? stellarPaymentAssets[0]
        const xlm = assetAmountToUnits(amount ?? '0', asset.decimals)
        if (xlm <= 0n) throw new Error(`Enter an offer greater than 0 ${asset.code}`)
        await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'make_offer', [
          StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }),
          StellarSdk.nativeToScVal(nftContractId, { type: 'address' }),
          StellarSdk.nativeToScVal(tokenId, { type: 'u32' }),
          StellarSdk.nativeToScVal(paymentToken, { type: 'address' }),
          StellarSdk.nativeToScVal(xlm, { type: 'i128' }),
          StellarSdk.nativeToScVal(0, { type: 'u32' }),
        ], stellarWallet, (stage) => setWalletActionStatus(stage))
        setWalletActionStatus('complete')
        trackProductEvent('marketplace_action_confirmed', { flow: 'offer', network: stellarWallet.network === 'PUBLIC' ? 'mainnet' : 'testnet' })
        notify(`Offer submitted for ${walletItem.title} on Stellar ${stellarWallet.network === 'PUBLIC' ? 'Mainnet' : 'Testnet'}`)
        refreshMarketplace()
        return
      }
      if (walletMode === 'offer') throw new Error('There is no live Testnet listing for this NFT yet')
      notify('There is no live Testnet listing for this NFT yet')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Soroban transaction failed'
      setWalletActionError(message)
      setWalletActionStatus('error')
      notify(message)
    }
  }

  const handleBulkBuy = async (items: NFT[]) => {
    if (!stellarWallet) { openWallet(); return }
    const marketplaceId = sorobanMarketplaceConfig.marketplaceContractId
    if (!marketplaceId) return notify('The marketplace contract is not configured')
    if (!items.length || items.length > 10) return notify('Select between 1 and 10 listed NFTs per checkout transaction')
    try {
      const calls = items.map((item) => {
        const listing = activeListings.find((entry) => entry.nft_contract.toLowerCase() === item.contractId?.toLowerCase() && entry.token_id === item.tokenId)
        if (!listing || listing.listing_id < 0) throw new Error(`${item.title} does not have a confirmed active listing`)
        return { method: 'buy', args: [StellarSdk.nativeToScVal(listing.listing_id, { type: 'u32' }), StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' })] }
      })
      await invokeSorobanBatch(marketplaceId, calls, stellarWallet)
      setActiveListings((current) => current.filter((listing) => !items.some((item) => item.contractId?.toLowerCase() === listing.nft_contract.toLowerCase() && item.tokenId === listing.token_id)))
      setMintedNfts((current) => current.map((mint) => items.some((item) => item.contractId?.toLowerCase() === mint.contract_id.toLowerCase() && item.tokenId === mint.token_id) ? { ...mint, owner_address: stellarWallet.address, owner_name: undefined } : mint))
      await fetchOwnedNfts(stellarWallet.address).then((owned) => { setOwnedTokens(owned.map(({ contract_id, token_id }) => ({ contract_id, token_id }))); setOwnershipSource('indexed') }).catch(() => {})
      refreshMarketplace()
      notify(`${items.length} NFT${items.length === 1 ? '' : 's'} purchased in one Stellar transaction`)
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Bulk checkout failed') }
  }

  const handleBulkList = async (rows: { item: NFT; price: string; paymentToken: string }[]) => {
    if (!stellarWallet) { openWallet(); return }
    const marketplaceId = sorobanMarketplaceConfig.marketplaceContractId
    if (!marketplaceId) return notify('The marketplace contract is not configured')
    if (!rows.length || rows.length > 10) return notify('Choose between 1 and 10 NFTs for one bulk listing')
    try {
      const latest = await sorobanServer.getLatestLedger()
      const expiry = latest.sequence + 500_000
      const prepared = rows.map(({ item, price, paymentToken }) => {
        const asset = stellarPaymentAssets.find((candidate) => candidate.contractId === paymentToken)
        if (!asset) throw new Error(`Choose a supported payment currency for ${item.title}`)
        const nftContract = item.contractId ?? sorobanMarketplaceConfig.nftContractId
        if (!nftContract || item.tokenId === undefined || item.ownerAddress?.toLowerCase() !== stellarWallet.address.toLowerCase()) throw new Error(`${item.title} is not confirmed as owned by your connected wallet`)
        if (activeListings.some((listing) => listing.nft_contract.toLowerCase() === nftContract.toLowerCase() && listing.token_id === item.tokenId)) throw new Error(`${item.title} already has a live listing`)
        const units = assetAmountToUnits(price, asset.decimals)
        if (units <= 0n) throw new Error(`Enter a price greater than 0 ${asset.code} for ${item.title}`)
        return { item, nftContract, tokenId: item.tokenId, units, asset }
      })
      const approvals = new Map<string, { method: string; args: StellarSdk.xdr.ScVal[] }[]>()
      for (const entry of prepared) {
        const group = approvals.get(entry.nftContract) ?? []
        group.push({ method: 'approve', args: [StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }), StellarSdk.nativeToScVal(marketplaceId, { type: 'address' }), StellarSdk.nativeToScVal(entry.tokenId, { type: 'u32' }), StellarSdk.nativeToScVal(expiry, { type: 'u32' })] })
        approvals.set(entry.nftContract, group)
      }
      for (const [nftContract, calls] of approvals) await invokeSorobanBatch(nftContract, calls, stellarWallet)
      const listings = prepared.map((entry) => ({ method: 'list', args: [StellarSdk.nativeToScVal(stellarWallet.address, { type: 'address' }), StellarSdk.nativeToScVal(entry.nftContract, { type: 'address' }), StellarSdk.nativeToScVal(entry.tokenId, { type: 'u32' }), StellarSdk.nativeToScVal(entry.asset.contractId, { type: 'address' }), StellarSdk.nativeToScVal(entry.units, { type: 'i128' }), StellarSdk.nativeToScVal(expiry, { type: 'u32' })] }))
      await invokeSorobanBatch(marketplaceId, listings, stellarWallet)
      refreshMarketplace()
      notify(`${rows.length} NFT${rows.length === 1 ? '' : 's'} listed together in one marketplace transaction`)
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Bulk listing failed') }
  }

  const startMintFlow = (collection?: Collection | WalletCollection) => {
    setCreateChooserOpen(false)
    if (!stellarWallet) { openWallet(); return }
    setMintTargetCollectionSlug(collection ? ('slug' in collection ? collection.slug : collection.id) : '')
    setFirstCollectionMintStep(false)
    setMintError('')
    setMintSuccess(null)
    setMintOpen(true)
  }

  const handleStageMintsConfirmed = (inputs: MintRecordInput[]) => {
    trackProductEvent('mint_confirmed', { flow: 'collection', network: stellarWallet?.network === 'PUBLIC' ? 'mainnet' : 'testnet', quantity: inputs.length })
    setPendingMintInputs((current) => {
      const merged = new Map<string, MintRecordInput>()
      for (const item of current) merged.set(`${item.contractId ?? ''}:${item.tokenId}`, item)
      for (const item of inputs) merged.set(`${item.contractId ?? ''}:${item.tokenId}`, item)
      return [...merged.values()]
    })
    setOwnedTokens((current) => {
      const merged = new Map<string, (typeof current)[number]>()
      for (const token of current) merged.set(`${token.contract_id.toLowerCase()}:${token.token_id}`, token)
      for (const input of inputs) if (input.contractId) merged.set(`${input.contractId.toLowerCase()}:${input.tokenId}`, { contract_id: input.contractId, token_id: input.tokenId })
      return [...merged.values()]
    })
    // A confirmed on-chain mint is enough to show the newly owned tokens
    // immediately; the ownership indexer can take a moment to catch up.
    setOwnershipSource('indexed')
  }

  const startCreatorStudio = (studio: 'pixel-studio' | 'ai-studio') => {
    setCreateChooserOpen(false)
    if (!stellarWallet) { openWallet(); return }
    setMintError('')
    setMintSuccess(null)
    navTo(studio)
  }

  const startPostFlow = () => {
    setCreateChooserOpen(false)
    navTo('home')
    setComposeOpen(true)
  }

  const postStudioArtworkToFeed = (artwork: File, caption: string) => {
    if (!stellarWallet) {
      notify('Connect your Stellar wallet to post artwork')
      openWallet()
      return
    }
    setComposeNft('')
    setComposeFile(artwork)
    setComposeText(caption)
    navTo('home')
    setComposeOpen(true)
  }

  const profileNames = [account?.creator_username && `@${account.creator_username}`, account?.display_name]
    .filter((name): name is string => Boolean(name?.trim()))
    .map((name) => name.trim().toLocaleLowerCase())
  const profilePostAvatar = posts.find((post) => post.author_type === 'user'
    && post.avatar
    && (post.is_me || profileNames.includes(post.author_name?.trim().toLocaleLowerCase() ?? '')))?.avatar
  const profileAvatar = account?.avatar || profilePostAvatar || ''

  if (window.location.pathname === '/admin/deploy') {
    return <DeploymentConsole wallet={stellarWallet} onConnect={handleConnectWallet} />
  }
  if (window.location.pathname === '/admin/media') {
    return <MediaAdmin wallet={stellarWallet} />
  }

  if (!introComplete) return <LaunchSplash />
  if (!stellarWallet && view !== 'analytics' && view !== 'feedback' && !detail) return <>
    <WelcomeView collections={allCollections} emailSignIn={privyAuth.configured} onSignUp={() => openWallet()} onLogIn={() => openWallet()} onConnectFreighter={() => void handleConnectFreighter()} />
    <InstallExperience />
    {walletOpen && <WalletModal key={`${walletMode}-${walletItem?.id ?? 'connect'}`} item={walletItem} mode={walletMode} auction={walletAuction} wallet={stellarWallet} emailSignIn={privyAuth.configured} emailReady={privyAuth.ready} onClose={() => setWalletOpen(false)} onConnect={handleConnectWallet} onConnectFreighter={handleConnectFreighter} onPurchase={handleOnChainAction} actionStatus={walletActionStatus} actionError={walletActionError} />}
    {toast && <Toast>{toast}</Toast>}
  </>

  return (
    <CreatorProfilesContext.Provider value={creatorProfiles}>
    <NftCardActionsContext.Provider value={{ walletAddress: stellarWallet?.address ?? '', marketplace, activeListings, activeAuctions, latestLedger, buy: (item) => openWallet(item, 'buy'), offer: (item) => openWallet(item, 'offer'), sell: handleSell, auction: (item) => openWallet(item, 'auction'), bid: (item) => openWallet(item, 'bid'), cancelAuction: handleCancelAuction, settleAuction: handleSettleAuction, cancelListing: handleCancelListing, acceptOffer: handleAcceptOffer }}>
    <div className="app-shell">
      <aside className="desktop-rail">
        <div className="rail-logo"><PrismMark /><span><b>Stella</b>Nova</span></div>
        <div className="rail-divider" />
        <nav className="rail-nav" aria-label="Primary navigation">
          <NavItem icon="home" label="Feed" active={view === 'home' && !detail} onClick={() => navTo('home')} />
          <NavItem icon="compass" label="Explore" active={view === 'explore' && !detail} onClick={() => navTo('explore')} />
          <NavItem icon="grid" label="Collections" active={view === 'collections' && !detail} onClick={() => navTo('collections')} />
          <NavItem icon="plus" label="Create" active={createChooserOpen} onClick={() => setCreateChooserOpen(true)} />
          <NavDropdown icon="spark" label="Studios" open={studioNavOpen} active={['pixel-studio', 'ai-studio', 'ai-collection-studio', 'painter-studio'].includes(view)} currentView={view} onToggle={() => togglePopover('studios')} items={[
            ['pixel-studio', 'Pixel Studio'], ['ai-studio', 'AI Art Studio'], ['ai-collection-studio', 'AI Collection Studio'], ['painter-studio', 'Painter & Mural Studio'],
          ]} onSelect={(nextView) => { navTo(nextView); setOpenPopover(null) }} />
          <NavDropdown icon="briefcase" label="Services" open={creativeNavOpen} active={['services', 'physical-art', 'exhibitions'].includes(view)} currentView={view} onToggle={() => togglePopover('creative')} items={[
            ['services', 'Services'], ['physical-art', 'Physical Art'], ['exhibitions', 'Exhibitions'],
          ]} onSelect={(nextView) => { navTo(nextView); setOpenPopover(null) }} />
          <NavItem icon="chart" label="Analytics" active={view === 'analytics' && !detail} onClick={() => navTo('analytics')} />
          <NavItem icon="comment" label="Feedback" active={view === 'feedback' && !detail} onClick={() => navTo('feedback')} />
        </nav>
        <div className="rail-bottom">
          {stellarWallet && <div className="profile-chip-wrap">
            <button className="profile-chip" aria-label="Open profile menu" aria-expanded={profileNavOpen} data-popover-trigger onClick={() => togglePopover('profile')}><Avatar src={profileAvatar} alt={(account?.display_name || 'Your profile')} size="sm" /><span><b>{account?.display_name || shortenStellarAddress(stellarWallet.address)}{account?.is_verified ? <Verified /> : null}</b><small>{account?.is_creator ? 'Creator' : 'Collector'}{account?.is_creator ? ' ? creator' : ''}</small></span><Icon name="chevron" size={15} /></button>
            {profileNavOpen && <div className="profile-menu" role="menu" aria-label="Profile navigation" data-popover-content>
              {([['account', 'Profile'], ['saved', 'Saved'], ['settings', 'Settings']] as [View, string][]).map(([nextView, label]) => <button type="button" role="menuitem" key={nextView} className={view === nextView ? 'is-active' : ''} onClick={() => { navTo(nextView); setOpenPopover(null) }}>{label}{nextView === 'saved' && saved.length > 0 ? <small>{saved.length}</small> : null}</button>)}
            </div>}
            {!account?.is_creator && <button className="profile-create" onClick={openCollectionCreation}><Icon name="plus" size={14} /> Create a collection</button>}
          </div>}
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu-button" aria-label="Open navigation" aria-expanded={navMenuOpen} data-popover-trigger onClick={() => togglePopover('mobile-menu')}><i /><i /><i /></button>
          <button className="mobile-brand" onClick={() => navTo('home')}><PrismMark small /><span><b>Stella</b>Nova</span></button>
          <div className="topbar__search"><Icon name="search" size={18} /><input aria-label="Search artworks, creators or collections" placeholder="Search art, creators, collections" value={search} onChange={(event) => handleSearch(event.target.value)} /><kbd>⌘ K</kbd></div>
          <div className="topbar__actions"><button className="top-icon notification-bell" aria-label="Notifications" aria-expanded={notificationsOpen} data-popover-trigger onClick={() => togglePopover('notifications')}><Icon name="bell" size={20} />{unreadCount > 0 && <em>{unreadCount}</em>}</button><Button variant={stellarWallet ? 'outline' : 'primary'} className="wallet-button" aria-label={stellarWallet ? 'Open wallet balances and transactions' : 'Connect wallet'} onClick={() => stellarWallet ? setWalletOverviewOpen(true) : openWallet()}><Icon name="wallet" size={16} />{stellarWallet ? shortenStellarAddress(stellarWallet.address) : privyAuth.configured ? 'Sign up' : 'Connect Wallet'}</Button><button className={`mobile-profile ${stellarWallet && profileAvatar ? 'mobile-profile--image' : ''}`} aria-label={stellarWallet ? 'Open account' : 'Sign up with email'} onClick={() => stellarWallet ? navTo('account') : openWallet()}>{stellarWallet && profileAvatar ? <Avatar src={profileAvatar} alt="Your profile" size="sm" /> : <Icon name={stellarWallet ? 'user' : 'wallet'} size={17} />}</button></div>
        </header>
        {navMenuOpen && <nav className="mobile-menu-popover" aria-label="Navigation menu" data-popover-content>
          {([['home', 'Feed'], ['explore', 'Explore'], ['collections', 'Collections'], ['saved', 'Saved'], ['account', 'Account']] as [View, string][]).map(([nextView, label]) => <button key={nextView} className={view === nextView ? 'is-active' : ''} onClick={() => { navTo(nextView); setOpenPopover(null) }}>{label}{nextView === 'saved' && saved.length > 0 ? <small>{saved.length}</small> : null}</button>)}
          <span className="mobile-menu-section-label">Services</span>
          {([['services', 'Services & commissions'], ['physical-art', 'Physical art'], ['exhibitions', 'Exhibitions']] as [View, string][]).map(([nextView,label]) => <button key={nextView} className={view === nextView ? 'is-active' : ''} onClick={() => { navTo(nextView); setOpenPopover(null) }}>{label}</button>)}
          <span className="mobile-menu-section-label">Creator studios</span>
          {([['pixel-studio', 'Pixel Studio'], ['ai-studio', 'AI Art Studio'], ['ai-collection-studio', 'AI Collection Studio'], ['painter-studio', 'Painter & Mural Studio']] as [View, string][]).map(([nextView, label]) => <button key={nextView} className={`mobile-menu-studio ${view === nextView ? 'is-active' : ''}`} onClick={() => { navTo(nextView); setOpenPopover(null) }}>{label}<Icon name="arrow" size={13} /></button>)}
          {([['analytics', 'Analytics'], ['settings', 'Settings'], ['feedback', 'Feedback']] as [View, string][]).map(([nextView, label]) => <button key={nextView} className={view === nextView ? 'is-active' : ''} onClick={() => { navTo(nextView); setOpenPopover(null) }}>{label}</button>)}
          <button type="button" onClick={() => { setOpenPopover(null); window.dispatchEvent(new Event('stellanova:install')) }}>Install StellaNova</button>
        </nav>}
        {notificationsOpen && (
          <div className="notification-popover" data-popover-content>
            <div className="notification-popover__header"><b>Notifications</b><button type="button" onClick={() => void handleMarkAllRead()} disabled={unreadCount === 0}>Mark all read</button></div>
            <div className="notification-browser-alerts">
              <span><b>Browser alerts</b><small>{browserPushState === 'on' ? 'Likes, collection mints, and marketplace activity' : browserPushState === 'denied' ? 'Allow notifications in your browser settings' : browserPushState === 'unsupported' ? 'Not supported by this browser' : 'Get important activity even when StellaNova is closed'}</small></span>
              <div className="notification-browser-alerts__actions">
                {(browserPushState === 'on' || browserPushState === 'off') && <button type="button" onClick={() => void handleBrowserPushToggle()} disabled={browserPushBusy || !stellarWallet}>{browserPushBusy ? 'Saving…' : browserPushState === 'on' ? 'Turn off' : 'Enable'}</button>}
                {browserPushState === 'on' && <button type="button" onClick={() => void handleBrowserPushTest()} disabled={browserPushTestBusy || !stellarWallet}>{browserPushTestBusy ? 'Sending…' : 'Send test alert'}</button>}
              </div>
            </div>
            {notifications.length ? notifications.slice(0, 6).map((note) => (
              <button className={`notification-item ${!note.read_at ? 'is-unread' : ''}`} key={`${note.id}-${note.created_at}-${note.title}-${note.body}`} onClick={() => handleNotificationClick(note)}>
                <span className="notification-item__kind">{note.kind}</span>
                {note.title && <strong>{note.title}</strong>}
                <span>{note.body}</span>
                {!note.read_at && <em className="notification-item__dot" />}
              </button>
            )) : <p>Wallet activity, offers, sales and collection drops appear here.</p>}
          </div>
        )}

        <div className="mobile-search"><Icon name="search" size={18} /><input aria-label="Search" placeholder="Search art, creators, collections" value={search} onChange={(event) => handleSearch(event.target.value)} /></div>

        {!isOnline && <div className="offline-banner"><Icon name="activity" size={15} /><span><b>You’re offline.</b> The app shell is available; Testnet data needs a connection.</span></div>}

        {detail ? <DetailView detail={detail} allNfts={socializedMarketNfts} allCollections={allCollections} posts={posts} saved={saved} toggleSaved={toggleSaved} openNft={openNft} onBack={() => { if (window.history.state?.stellaNovaRoute) window.history.back(); else navTo('home') }} onCreator={(id) => setDetail({ type: 'creator', id })} onCollection={(item) => setDetail({ type: 'collection', item })} onBuy={(item) => openWallet(item, item.saleType === 'Auction' ? 'bid' : 'buy')} onOffer={(item) => openWallet(item, 'offer')} comments={comments} onComment={addComment} liked={liked} disliked={disliked} onLike={handleFeedNftLike} onDislike={toggleDislike} onSell={handleSell} creatorFollows={creatorFollows} onFollowCreator={handleCreatorFollow} subscribedCollections={subscribedCollections} onFollowCollection={toggleSubscription} stellarWallet={stellarWallet} walletCollections={walletCollections} marketplace={marketplace} onAcceptOffer={handleAcceptOffer} onRejectOffer={handleRejectOffer} onCounterOffer={handleCounterOffer} notify={notify} setMintedNfts={setMintedNfts} onStageMintsConfirmed={handleStageMintsConfirmed} onCreateCollectionPost={handleCreateCollectionPost} onCreateCollectionStory={handleCreateCollectionStory} onPostLike={handleFeedPostLike} onPostDislike={handlePostDislike} onPostComment={handlePostComment} onCollectionUpdated={(id, changes) => { setAllCollections((items) => items.map((item) => item.id === id ? { ...item, ...changes } : item)); setWalletCollections((items) => items.map((item) => item.slug === id ? { ...item, cover: changes.cover ?? item.cover } : item)); setDetail((current) => current?.type === 'collection' && current.item.id === id ? { ...current, item: { ...current.item, ...changes } } : current) }} /> : (
          <>
            {view === 'home' && <HomeView allNfts={socializedMarketNfts} ownedNfts={ownedItems} composeNft={composeNft} setComposeNft={setComposeNft} onMintNft={startMintFlow} authorName={account?.creator_username ? `@${account.creator_username}` : account?.display_name || 'Creator'} authorAvatar={account?.avatar || ''} allCollections={allCollections} onOpen={openNft} saved={saved} toggleSaved={toggleSaved} onCreator={(id) => setDetail({ type: 'creator', id })} onCollection={(item) => setDetail({ type: 'collection', item })} feedPreferences={feedPreferences} liked={liked} disliked={disliked} comments={comments} onLike={handleFeedNftLike} onDislike={toggleDislike} onNftComment={addComment} posts={posts} storyGroups={storyGroups} sharedPostId={sharedPostId} walletAddress={stellarWallet?.address ?? ''} stellarWallet={stellarWallet} onCreateCreatorStory={handleCreateCreatorStory} notify={notify} onBuyMarketItem={(item) => openWallet(item, item.saleType === 'Auction' ? 'bid' : 'buy')} onOfferMarketItem={(item) => openWallet(item, 'offer')} postsLoadState={postsLoadState} onRetryPosts={loadPosts} composeOpen={composeOpen} setComposeOpen={setComposeOpen} composeText={composeText} setComposeText={setComposeText} composeFile={composeFile} setComposeFile={setComposeFile} posting={posting} onCreatePost={handleCreatePost} onPostLike={handleFeedPostLike} onPostDislike={handlePostDislike} onPostComment={handlePostComment} onTipPost={handleTipPost} />}
            {view === 'explore' && <ExploreView allCollections={allCollections} activeListings={activeListings} onBulkBuy={handleBulkBuy} onSell={handleSell} liked={liked} disliked={disliked} onLike={handleFeedNftLike} onDislike={toggleDislike} items={filteredNfts} onOpen={openNft} saved={saved} toggleSaved={toggleSaved} activeFilter={activeFilter} setActiveFilter={setActiveFilter} marketTab={marketTab} setMarketTab={setMarketTab} sortBy={sortBy} setSortBy={setSortBy} onCreator={(id) => setDetail({ type: 'creator', id })} onCollection={(item) => setDetail({ type: 'collection', item })} />}
            {view === 'services' && <CreatorServicesPage wallet={stellarWallet} notify={notify} />}
            {view === 'physical-art' && <PhysicalArtPage wallet={stellarWallet} notify={notify} />}
            {view === 'exhibitions' && <ExhibitionsPage wallet={stellarWallet} notify={notify} />}
            {view === 'collections' && <CollectionsView collections={allCollections} posts={posts} allNfts={socializedMarketNfts} walletAddress={stellarWallet?.address ?? ''} onOpen={(item) => setDetail({ type: 'collection', item })} onOpenNft={openNft} onCreator={(id) => setDetail({ type: 'creator', id })} onBuyNft={(item) => openWallet(item, item.saleType === 'Auction' ? 'bid' : 'buy')} onOfferNft={(item) => openWallet(item, 'offer')} onPostLike={handleFeedPostLike} onPostDislike={handlePostDislike} onPostComment={handlePostComment} disliked={disliked} subscribedCollections={subscribedCollections} onSubscribe={toggleSubscription} collectionSocial={collectionSocial} onCollectionReaction={handleCollectionReaction} onCollectionComment={handleCollectionComment} />}
            {view === 'saved' && <SavedView allCollections={allCollections} onSell={handleSell} liked={liked} disliked={disliked} onLike={handleFeedNftLike} onDislike={toggleDislike} saved={saved} items={marketNfts.filter((item) => saved.includes(item.id))} onOpen={openNft} toggleSaved={toggleSaved} onCollection={(item) => setDetail({ type: 'collection', item })} />}
            {view === 'account' && <AccountView allNfts={socializedMarketNfts} ownedNfts={[...ownedItems, ...accountOwnedMints.map((mint) => mintedToNft(mint, allCollections))]} allCollections={allCollections} posts={posts} account={account} stellarWallet={stellarWallet} walletCollections={walletCollections} onCopyAddress={copyStellarAddress} onCreateCollection={openCollectionCreation} onOpen={openNft} saved={saved} toggleSaved={toggleSaved} liked={liked} disliked={disliked} onLike={handleFeedNftLike} onDislike={toggleDislike} onSell={handleSell} onBulkList={handleBulkList} onCollection={(item) => setDetail({ type: 'collection', item })} onCreator={(id) => setDetail({ type: 'creator', id })} subscriptions={subscribedCollections} onSubscribe={toggleSubscription} onCreateMint={startMintFlow} marketplace={marketplace} onCancelListing={handleCancelListing} onCancelOffer={handleCancelOffer} onAcceptOffer={handleAcceptOffer} onRejectOffer={handleRejectOffer} onCounterOffer={handleCounterOffer} onCounterResponse={handleCounterResponse} onSaveProfile={savePublicProfile} onDisconnectWallet={handleDisconnectWallet} />}
            {view === 'analytics' && <AnalyticsView walletAddress={stellarWallet?.address ?? ''} isAdmin={Boolean(account?.is_admin)} />}
            {view === 'settings' && <SettingsView feedPreferences={feedPreferences} setFeedPreferences={setFeedPreferences} />}
            {view === 'feedback' && <FeedbackView />}
            {view === 'pixel-studio' && <PixelStudioPage collections={walletCollections} busy={minting} error={mintError} success={mintSuccess} onMint={handleMintNft} onHome={() => navTo('home')} />}
            {view === 'ai-studio' && <AiStudioPage collections={walletCollections} busy={minting} error={mintError} success={mintSuccess} onMint={handleMintNft} onGenerate={generateAiArtwork} onPostToFeed={postStudioArtworkToFeed} onHome={() => navTo('home')} />}
            {view === 'ai-collection-studio' && <AiCollectionStudioPage walletAddress={stellarWallet?.address ?? ''} onGenerate={generateAiArtwork} onAnalyze={analyzeAiArtwork} onVerifyTraits={verifyAiArtworkTraits} onPlanTraits={planAiCollectionTraits} onCreateCollection={createAiStudioCollection} onSaveArtwork={saveAiStudioArtwork} onOpenCollectionDashboard={(slug: string) => { const item = allCollections.find((collection) => collection.id === slug) ?? collectionFor(slug); setView('home'); setDetail({ type: 'collection', item }) }} onHome={() => navTo('home')} />}
            {view === 'painter-studio' && <PainterStudioPage collections={walletCollections} busy={minting} error={mintError} success={mintSuccess} onMint={handleMintNft} onPostToFeed={postStudioArtworkToFeed} onHome={() => navTo('home')} />}
          </>
        )}
      </main>

      <nav className="mobile-dock" aria-label="Primary navigation">
        <DockItem icon="home" label="Feed" active={view === 'home' && !detail} onClick={() => navTo('home')} />
        <DockItem icon="compass" label="Explore" active={view === 'explore' && !detail} onClick={() => navTo('explore')} />
        <button className="dock-create" aria-label="Create" onClick={() => setCreateChooserOpen(true)}><Icon name="plus" size={20} /><span>Create</span></button>
        <DockItem icon="grid" label="Collections" active={view === 'collections' && !detail} onClick={() => navTo('collections')} />
        <DockItem icon="user" label="Account" active={view === 'account' && !detail} onClick={() => (stellarWallet ? navTo('account') : openWallet())} />
      </nav>

      {walletOpen && <WalletModal key={`${walletMode}-${walletItem?.id ?? 'connect'}`} item={walletItem} mode={walletMode} auction={walletAuction} wallet={stellarWallet} emailSignIn={privyAuth.configured} emailReady={privyAuth.ready} onClose={() => setWalletOpen(false)} onConnect={handleConnectWallet} onConnectFreighter={handleConnectFreighter} onPurchase={handleOnChainAction} actionStatus={walletActionStatus} actionError={walletActionError} />}
      {walletOverviewOpen && stellarWallet && <WalletDetailsModal wallet={stellarWallet} onClose={() => setWalletOverviewOpen(false)} />}
      {onboardingOpen && <CreatorOnboardingModal name={onboardName} setName={setOnboardName} symbol={onboardSymbol} setSymbol={setOnboardSymbol} description={onboardDesc} setDescription={setOnboardDesc} totalSupply={onboardSupply} setTotalSupply={setOnboardSupply} coverImage={onboardCover} setCoverImage={setOnboardCover} creating={collectionCreating} onClose={closeCollectionCreation} onCreate={handleCreateMyCollection} />}
      {mintOpen && <MintModal open={mintOpen} firstCollectionMintStep={firstCollectionMintStep} onClose={() => { setMintOpen(false); setFirstCollectionMintStep(false) }} targetCollection={walletCollections.find((collection) => collection.slug === mintTargetCollectionSlug) ?? null} success={mintSuccess} onDone={() => { const target = walletCollections.find((collection) => collection.slug === mintTargetCollectionSlug); setMintOpen(false); setFirstCollectionMintStep(false); setMintTitle(''); setMintDescription(''); setMintFile(null); setMintArtworkUrl(''); setMintMediaFile(null); setMintTraits(''); setMintSuccess(null); if (target) { const item = allCollections.find((collection) => collection.id === target.slug) ?? collectionFor(target.slug); setView('collections'); setDetail({ type: 'collection', item }) } else navTo('account') }} title={mintTitle} setTitle={setMintTitle} description={mintDescription} setDescription={setMintDescription} artwork={mintFile} setArtwork={setMintFile} artworkUrl={mintArtworkUrl} setArtworkUrl={setMintArtworkUrl} media={mintMediaFile} setMedia={setMintMediaFile} traits={mintTraits} setTraits={setMintTraits} error={mintError} onMint={() => handleMintNft(undefined, mintTargetCollectionSlug)} minting={minting} />}
      {createChooserOpen && <CreateChooser onClose={() => setCreateChooserOpen(false)} onPost={startPostFlow} onMint={startMintFlow} />}
      {toast && <Toast>{toast}</Toast>}
      <InstallExperience />
    </div>
    </NftCardActionsContext.Provider>
    </CreatorProfilesContext.Provider>
  )
}

function InstallExperience() {
  const [promptEvent, setPromptEvent] = useState<(Event & { prompt?: () => Promise<void>; userChoice?: Promise<{ outcome: string }> }) | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  const inTelegram = Boolean(telegramWebApp())

  useEffect(() => {
    const beforeInstall = (event: Event) => {
      event.preventDefault()
      setPromptEvent(event as Event & { prompt?: () => Promise<void>; userChoice?: Promise<{ outcome: string }> })
    }
    const installedHandler = () => { setInstalled(true); setGuideOpen(false); setPromptEvent(null) }
    const requestInstall = () => setGuideOpen(true)
    const displayMode = window.matchMedia('(display-mode: standalone)')
    const displayModeChanged = () => setInstalled(displayMode.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
    window.addEventListener('beforeinstallprompt', beforeInstall)
    window.addEventListener('appinstalled', installedHandler)
    window.addEventListener('stellanova:install', requestInstall)
    displayMode.addEventListener?.('change', displayModeChanged)
    return () => {
      window.removeEventListener('beforeinstallprompt', beforeInstall)
      window.removeEventListener('appinstalled', installedHandler)
      window.removeEventListener('stellanova:install', requestInstall)
      displayMode.removeEventListener?.('change', displayModeChanged)
    }
  }, [])

  const install = async () => {
    if (!promptEvent?.prompt) { setGuideOpen(true); return }
    await promptEvent.prompt()
    const choice = await promptEvent.userChoice
    if (choice?.outcome === 'accepted') setGuideOpen(false)
    setPromptEvent(null)
  }

  return <>
    {guideOpen && !installed && <div className="pwa-install-backdrop" role="presentation" onClick={() => setGuideOpen(false)}>
      <section className="pwa-install-dialog" role="dialog" aria-modal="true" aria-labelledby="pwa-install-title" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="pwa-install-close" onClick={() => setGuideOpen(false)} aria-label="Close">×</button>
        <span className="eyebrow">STELLANOVA APP</span>
        <h2 id="pwa-install-title">Take StellaNova with you</h2>
        {inTelegram ? <><p>Install StellaNova from your browser for a full-screen app experience. Your account and collections stay available on the web too.</p><Button onClick={() => { openCurrentPageInBrowser(); setGuideOpen(false) }}>Open in browser</Button></>
          : promptEvent ? <><p>Add StellaNova to your home screen for a fast, app-like experience.</p><Button onClick={() => void install()}>Install StellaNova</Button></>
            : /iPad|iPhone|iPod/.test(navigator.userAgent) ? <><p>In Safari, tap <b>Share</b>, then choose <b>Add to Home Screen</b>.</p><Button variant="outline" onClick={() => setGuideOpen(false)}>Got it</Button></>
              : <><p>Choose <b>Install app</b> or <b>Add to Home screen</b> from your browser menu to use StellaNova as an app.</p><Button variant="outline" onClick={() => setGuideOpen(false)}>Got it</Button></>}
      </section>
    </div>}
  </>
}

function DeploymentConsole({ wallet, onConnect }: { wallet: StellarWallet | null; onConnect: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const configuredNftContract = import.meta.env.VITE_STELLAR_NFT_CONTRACT_ID ?? ''
  const configuredMarketplaceContract = import.meta.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? ''
  const [status, setStatus] = useState(() => configuredNftContract && configuredMarketplaceContract
    ? 'Updated NFT and marketplace contracts are deployed and configured for Stellar Testnet.'
    : 'Connect Freighter, then deploy the audited Testnet contracts.')
  const [nftContract, setNftContract] = useState(() => configuredNftContract || window.localStorage.getItem('nftgram:nft-contract') || '')
  const [marketplaceContract, setMarketplaceContract] = useState(() => configuredMarketplaceContract || window.localStorage.getItem('nftgram:marketplace-contract') || '')

  const deploy = async () => {
    if (!wallet) {
      await onConnect()
      return
    }
    const metadataBaseUri = window.prompt('Enter the HTTPS base URL for real NFT metadata. It must end with /')?.trim() ?? ''
    if (!/^https:\/\/.+\/$/.test(metadataBaseUri)) {
      setStatus('Deployment needs a real HTTPS metadata base URL ending in /.')
      return
    }
    setBusy(true)
    try {
      setStatus('Installing and deploying the SEP-50 NFT contract. Freighter will request Testnet signatures for installation, creation and configuration.')
      const nft = await deploySorobanWasm('/contracts/nftgram_nft.wasm', wallet, [
        StellarSdk.nativeToScVal(metadataBaseUri, { type: 'string' }),
        StellarSdk.nativeToScVal('StellaNova Editions', { type: 'string' }),
        StellarSdk.nativeToScVal('STNV', { type: 'string' }),
        StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
      ])
      setNftContract(nft.contractAddress)
      window.localStorage.setItem('nftgram:nft-contract', nft.contractAddress)
      setStatus(`NFT contract deployed and initialized at ${nft.contractAddress}. Configuring payment token…`)
      if (!sorobanMarketplaceConfig.paymentToken) throw new Error('Set VITE_STELLAR_PAYMENT_TOKEN before deploying paid creator drops')
      await invokeSoroban(nft.contractAddress, 'set_payment_token', [
        StellarSdk.nativeToScVal(sorobanMarketplaceConfig.paymentToken, { type: 'address' }),
      ], wallet)
      await registerNftContract(wallet.address, nft.contractAddress)

      setStatus('Installing and deploying the Soroban marketplace contract. Freighter will request more Testnet signatures.')
      const marketplace = await deploySorobanWasm('/contracts/nftgram_marketplace.wasm', wallet, [
        StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
        StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
        StellarSdk.nativeToScVal(250, { type: 'u32' }),
      ])
      setMarketplaceContract(marketplace.contractAddress)
      window.localStorage.setItem('nftgram:marketplace-contract', marketplace.contractAddress)
      setStatus('Both contracts are deployed and initialized on Stellar Testnet. The NFT contract is registered for collections, direct minting and tiered drops.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Deployment stopped before completion.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="app-shell"><main className="main-content"><div className="page"><section className="page-heading page-heading--compact"><div><span className="eyebrow">STELLAR TESTNET · DEPLOYMENT</span><h1>Make StellaNova<br /><i>real on-chain.</i></h1></div><button className="round-action" onClick={() => window.location.assign('/')} aria-label="Back to StellaNova"><Icon name="arrow" size={20} /></button></section><section className="section-block"><div className="section-title"><div><span className="eyebrow">SOROBAN CONTRACTS</span><h3>SEP-50 NFT + marketplace</h3></div><span className="market-status"><i /> TESTNET ONLY</span></div><p className="collection-description">This console installs and deploys the compiled contracts, then initializes StellaNova metadata and a 2.5% marketplace fee. Every network transaction is simulated, prepared and signed by your connected Freighter wallet.</p><div className="purchase-intent"><div><small>Wallet</small><b>{wallet ? shortenStellarAddress(wallet.address) : 'Not connected'}</b><em>{wallet ? 'Ready for Freighter signing' : 'Connect to continue'}</em></div><Button onClick={wallet ? deploy : onConnect} disabled={busy}>{busy ? 'Waiting for Testnet…' : wallet ? 'Deploy contracts' : 'Connect Freighter'} <Icon name="arrow" size={15} /></Button></div><div className="detail-meta"><Meta label="NFT contract" value={nftContract || 'Not deployed'} /><Meta label="Marketplace" value={marketplaceContract || 'Not deployed'} /><Meta label="Network" value="Stellar Testnet" /><Meta label="Fee" value="2.5%" /></div><div className="detail-note"><Icon name="spark" size={16} /><span><b>Deployment status</b><small>{status}</small></span></div></section><section className="section-block"><div className="section-title"><div><span className="eyebrow">NEXT CONFIGURATION</span><h3>Connect the deployed IDs</h3></div></div><p className="collection-description">After deployment, set <code>VITE_STELLAR_NFT_CONTRACT_ID</code> and <code>VITE_STELLAR_MARKETPLACE_CONTRACT_ID</code> in the project environment and reload StellaNova. Testnet contract IDs are stored locally in this browser for this deployment session.</p></section></div></main></div>
}

function NavItem({ icon, label, active, count, onClick }: { icon: 'home' | 'compass' | 'grid' | 'layers' | 'pixel' | 'bookmark' | 'user' | 'settings' | 'plus' | 'activity' | 'image' | 'spark' | 'briefcase' | 'gallery' | 'palette' | 'chart' | 'comment'; label: string; active?: boolean; count?: number; onClick: () => void }) {
  return <button className={`rail-nav__item ${active ? 'is-active' : ''}`} onClick={onClick} aria-label={label} title={label} data-tooltip={label}><Icon name={icon} size={20} /><span>{label}</span>{count ? <em>{count}</em> : null}</button>
}

function NavDropdown({ icon, label, open, active, currentView, onToggle, items, onSelect }: { icon: 'spark' | 'briefcase'; label: string; open: boolean; active: boolean; currentView: View; onToggle: () => void; items: [View, string][]; onSelect: (view: View) => void }) {
  return <div className={`rail-nav__group ${open ? 'is-open' : ''}`}>
    <button type="button" className={`rail-nav__item rail-nav__group-trigger ${active ? 'is-active' : ''}`} aria-label={label} aria-expanded={open} title={label} data-tooltip={label} data-popover-trigger onClick={onToggle}>
      <Icon name={icon} size={20} /><span>{label}</span>
    </button>
    {open && <div className="rail-nav__submenu" role="menu" aria-label={label} data-popover-content>
      {items.map(([view, itemLabel]) => <button type="button" role="menuitem" key={view} className={`rail-nav__submenu-item ${currentView === view ? 'is-active' : ''}`} onClick={() => onSelect(view)}>{itemLabel}</button>)}
    </div>}
  </div>
}

function DockItem({ icon, label, active, count, onClick }: { icon: 'home' | 'compass' | 'grid' | 'bookmark' | 'user'; label: string; active?: boolean; count?: number; onClick: () => void }) {
  return <button className={`dock-item ${active ? 'is-active' : ''}`} onClick={onClick}><span className="dock-icon"><Icon name={icon} size={20} />{count ? <em>{count}</em> : null}</span><small>{label}</small></button>
}

function LaunchSplash() {
  return <main className="launch-splash" aria-label="Loading StellaNova"><PrismMark size={38} /><span><b>Stella</b>Nova</span></main>
}

function WelcomeView({ collections, emailSignIn, onSignUp, onLogIn, onConnectFreighter }: { collections: Collection[]; emailSignIn: boolean; onSignUp: () => void; onLogIn: () => void; onConnectFreighter: () => void }) {
  const previews = collections.filter((collection) => collection.cover).slice(0, 3)
  return <main className="auth-landing">
    <section className="auth-landing__story">
      <div className="auth-landing__message"><h1>Discover digital collectibles<br />from your <em>favorite creators.</em></h1>
        <div className="auth-preview" aria-label="A preview of StellaNova collectibles">
          {previews.length ? previews.map((collection, index) => <div key={collection.id} className={`auth-preview__tile auth-preview__tile--${index + 1}`}><img src={mediaSource(collection.cover)} alt={collection.name} /></div>) : nfts.slice(0, 3).map((item, index) => <div key={item.id} className={`auth-preview__tile auth-preview__tile--${index + 1}`}><img src={mediaSource(item.image)} alt={item.title} /></div>)}
          {!previews.length && !nfts.length && <div className="auth-preview__tile auth-preview__tile--placeholder auth-preview__tile--2"><span className="auth-preview__placeholder-art">✦</span></div>}
        </div>
      </div>
    </section>
    <section className="auth-landing__join">
      <div className="auth-landing__join-inner"><PrismMark size={96} className="stellanova-mark--welcome" /><h2>Explore and collect<br />digital art on StellaNova</h2>
        <Button onClick={emailSignIn ? onSignUp : onConnectFreighter}>Explore StellaNova</Button>
        <div className="auth-landing__signin"><button onClick={onLogIn}>Log in</button><span>or</span><button onClick={onSignUp}>Sign up</button></div>
        <a className="auth-landing__feedback" href="/feedback">Give feedback</a>
      </div>
    </section>
  </main>
}

function CollectionStories({ groups, collections, onCollection, wallet, onCreate, notify }: { groups: CollectionStoryGroup[]; collections: Collection[]; onCollection: (item: Collection) => void; wallet: StellarWallet | null; onCreate: (caption: string, mediaUrl: string, mediaType: 'image' | 'video') => Promise<void>; notify: (message: string) => void }) {
  const [active, setActive] = useState<{ group: CollectionStoryGroup; index: number } | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [caption, setCaption] = useState('')
  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState(0)
  const [viewedLocally, setViewedLocally] = useState<Set<string>>(() => new Set())
  const visible = groups.filter((group) => group.isMine || group.stories.length > 0)
  const current = active ? active.group.stories[active.index] : null
  const markViewed = (group: CollectionStoryGroup, index: number) => {
    const story = group.stories[index]
    if (!story || story.viewed || viewedLocally.has(`${group.kind}:${story.id}`)) return
    setViewedLocally((currentViewed) => new Set(currentViewed).add(`${group.kind}:${story.id}`))
    if (wallet) void markStoryViewed(wallet.address, group.kind, story.id).catch(() => {})
  }
  const openGroup = (group: CollectionStoryGroup) => {
    if (!group.stories.length) return
    setActive({ group, index: 0 })
    markViewed(group, 0)
  }
  const step = (direction: number) => {
    if (!active) return
    const next = active.index + direction
    if (next >= 0 && next < active.group.stories.length) { setActive({ ...active, index: next }); markViewed(active.group, next) }
    else {
      const playable = visible.filter((group) => group.stories.length > 0)
      const groupIndex = playable.findIndex((group) => group.collectionId === active.group.collectionId) + direction
      const nextGroup = playable[groupIndex]
      if (nextGroup?.stories.length) { const index = direction > 0 ? 0 : nextGroup.stories.length - 1; setActive({ group: nextGroup, index }); markViewed(nextGroup, index) }
      else setActive(null)
    }
  }
  useEffect(() => {
    if (!active || !current || current.mediaType === 'video') return
    setProgress(0)
    const started = Date.now()
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - started
      setProgress(Math.min(100, elapsed / 6000 * 100))
      if (elapsed >= 6000) { window.clearInterval(timer); step(1) }
    }, 50)
    return () => window.clearInterval(timer)
  }, [active?.group.collectionId, active?.index, current?.id])
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setActive(null); if (event.key === 'ArrowLeft') step(-1); if (event.key === 'ArrowRight') step(1) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, visible])
  const yourStatus = visible.find((group) => group.kind === 'creator' && group.isMine)
  const otherGroups = visible.filter((group) => !(group.kind === 'creator' && group.isMine))
  const hasUnseen = (group: CollectionStoryGroup) => group.stories.some((story) => !story.viewed && !viewedLocally.has(`${group.kind}:${story.id}`))
  return <><section className="desktop-stories" aria-label="Stories"><div className="desktop-stories__row">
    <button className={`desktop-story ${yourStatus?.stories.length ? (hasUnseen(yourStatus) ? 'desktop-story--unseen' : 'desktop-story--seen') : 'desktop-story--empty'}`} title={wallet ? 'Add or view your status' : 'Sign in to share a status'} onClick={() => { if (!wallet) { notify('Sign in to share a status'); return } yourStatus?.stories.length ? openGroup(yourStatus) : setComposeOpen(true) }}><span><Avatar src={yourStatus?.cover || ''} alt="Your status" size="md" ring />{!yourStatus?.stories.length && <i>+</i>}</span><small>Your status</small></button>
    {otherGroups.map((group) => {
      const isCollection = group.kind === 'collection'
      const collection = isCollection ? collections.find((item) => item.id === group.collectionId) ?? collectionFor(group.collectionId) : null
      return <button className={`desktop-story ${hasUnseen(group) ? 'desktop-story--unseen' : 'desktop-story--seen'}`} key={`${group.kind}:${group.collectionId}`} onClick={() => group.stories.length ? openGroup(group) : collection && onCollection(collection)}><span><Avatar src={group.cover || collection?.cover || ''} alt={group.name} size="md" ring /></span><small>{group.name}</small><em>{isCollection ? 'Collection' : 'Person'}</em></button>
    })}
    {!otherGroups.length && <p className="desktop-stories__empty">Stories from people you follow or who follow you, and collections you follow or hold, appear here.</p>}
  </div></section>
  {composeOpen && <div className="story-compose-backdrop" role="presentation" onClick={() => setComposeOpen(false)}><section className="story-compose" role="dialog" aria-modal="true" aria-labelledby="story-compose-title" onClick={(event) => event.stopPropagation()}><button className="story-compose__close" onClick={() => setComposeOpen(false)} aria-label="Close">×</button><h2 id="story-compose-title">Add to your status</h2><p>Your followers and people you follow can see it for 24 hours.</p><textarea rows={3} maxLength={500} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Write a status…" aria-label="Status caption" /><label className="button button--outline story-file-picker">{mediaFile?.name || 'Choose photo or video'}<input type="file" accept="image/*,video/mp4,video/webm,video/quicktime" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; if (file && file.size > 50 * 1024 * 1024) { notify('Choose a photo or video under 50 MB'); event.currentTarget.value = ''; return } setMediaFile(file) }} /></label><Button disabled={saving || (!caption.trim() && !mediaFile)} onClick={async () => { if (!wallet || (!caption.trim() && !mediaFile)) return; setSaving(true); try { let url = ''; if (mediaFile) { const uploaded = await uploadMedia(mediaFile, 'creator-story', { walletAddress: wallet.address }); url = uploaded.original.r2Url ?? uploaded.original.cloudinaryUrl ?? ''; if (!url) throw new Error('The story upload did not return a public URL') } const type = mediaFile?.type.startsWith('video/') ? 'video' : 'image'; await onCreate(caption, url, type); setCaption(''); setMediaFile(null); setComposeOpen(false) } catch (error) { notify(error instanceof Error ? error.message : 'Unable to share status') } finally { setSaving(false) } }}>{saving ? 'Sharing…' : 'Share status'}</Button></section></div>}
  {active && current && <div className="story-viewer" role="dialog" aria-modal="true" aria-label={`${active.group.name} story`} onClick={() => setActive(null)}><div className="story-viewer__card" onClick={(event) => event.stopPropagation()}><div className="story-viewer__segments">{active.group.stories.map((story, index) => <span key={`${active.group.kind}:${story.id}`} className="story-viewer__progress"><i style={{ width: index < active.index ? '100%' : index === active.index ? `${progress}%` : '0%' }} /></span>)}</div><header><Avatar src={active.group.cover} alt={active.group.name} size="xs" /><b>{active.group.name}</b><small>{new Date(current.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small><button onClick={() => setActive(null)} aria-label="Close story">×</button></header>{current.mediaUrl ? current.mediaType === 'video' ? <video src={current.mediaUrl} controls autoPlay playsInline onTimeUpdate={(event) => { const video = event.currentTarget; if (video.duration) setProgress(video.currentTime / video.duration * 100) }} onEnded={() => step(1)} /> : <img src={current.mediaUrl} alt={current.caption || `${active.group.name} story`} /> : <div className="story-viewer__text">{current.caption}</div>}{current.mediaUrl && current.caption && <p>{current.caption}</p>}<button className="story-viewer__prev" aria-label="Previous story" onClick={() => step(-1)} /><button className="story-viewer__next" aria-label="Next story" onClick={() => step(1)} /></div></div>}
  </>
}

function HomeView({ allNfts, ownedNfts, walletAddress, stellarWallet, onCreateCreatorStory, notify, onBuyMarketItem, onOfferMarketItem, composeNft, setComposeNft, onMintNft, authorName, authorAvatar, allCollections, onOpen, saved, toggleSaved, onCreator, onCollection, feedPreferences, liked, disliked, comments, onLike, onDislike, onNftComment, posts, storyGroups, sharedPostId, postsLoadState, onRetryPosts, composeOpen, setComposeOpen, composeText, setComposeText, composeFile, setComposeFile, posting, onCreatePost, onPostLike, onPostDislike, onPostComment, onTipPost }: { allNfts: NFT[]; ownedNfts: NFT[]; walletAddress: string; stellarWallet: StellarWallet | null; onCreateCreatorStory: (caption: string, mediaUrl: string, mediaType: 'image' | 'video') => Promise<void>; notify: (message: string) => void; onBuyMarketItem: (item: NFT) => void; onOfferMarketItem: (item: NFT) => void; composeNft: string; setComposeNft: (id: string) => void; onMintNft: () => void; authorName: string; authorAvatar: string; allCollections: Collection[]; onOpen: (item: NFT) => void; saved: string[]; toggleSaved: (id: string) => void; onCreator: (id: string) => void; onCollection: (item: Collection) => void; feedPreferences: FeedPreferences; liked: string[]; disliked: string[]; comments: Record<string, SocialComment[]>; onLike: (id: string) => void; onDislike: (id: string) => void; onNftComment: (id: string, text: string, parentId?: number | string | null) => Promise<void>; posts: PostRecord[]; storyGroups: CollectionStoryGroup[]; sharedPostId: number; postsLoadState: 'loading' | 'ready' | 'error'; onRetryPosts: () => void; composeOpen: boolean; setComposeOpen: (v: boolean) => void; composeText: string; setComposeText: (v: string) => void; composeFile: File | null; setComposeFile: (v: File | null) => void; posting: boolean; onCreatePost: () => void | Promise<void>; onPostLike: (id: number) => void; onPostDislike: (id: number) => void; onPostComment: (id: number, text: string, parentId?: number | string | null) => Promise<void>; onTipPost: (id: number, recipient: string, amount: string, onProgress: (stage: 'preparing' | 'awaiting-wallet' | 'confirming') => void) => Promise<{ hash: string; amount: string; tipsCount?: number }> }) {
  return <div className="page page--feed">
    <CollectionStories groups={storyGroups} collections={allCollections} onCollection={onCollection} wallet={stellarWallet} onCreate={onCreateCreatorStory} notify={notify} />
    <SocialFeed posts={posts} allNfts={allNfts} walletAddress={walletAddress} onBuyMarketItem={onBuyMarketItem} onOfferMarketItem={onOfferMarketItem} ownedNfts={ownedNfts} composeNft={composeNft} setComposeNft={setComposeNft} onMintNft={onMintNft} authorName={authorName} authorAvatar={authorAvatar} allCollections={allCollections} saved={saved} onOpenArtwork={onOpen} onSaveArtwork={toggleSaved} onCollection={onCollection} liked={liked} disliked={disliked} comments={comments} onLikeArtwork={onLike} onDislikeArtwork={onDislike} onNftComment={onNftComment} feedPreferences={feedPreferences} sharedPostId={sharedPostId} postsLoadState={postsLoadState} onRetryPosts={onRetryPosts} composeOpen={composeOpen} setComposeOpen={setComposeOpen} composeText={composeText} setComposeText={setComposeText} composeFile={composeFile} setComposeFile={setComposeFile} posting={posting} onCreatePost={onCreatePost} onPostLike={onPostLike} onPostDislike={onPostDislike} onPostComment={onPostComment} onTipPost={onTipPost} onCreator={onCreator} />
    <aside className="desktop-suggestions"><h3>Suggested for you</h3>{Array.from(new Map(posts.map((post) => [post.author_type === 'collection' ? `collection:${post.collection_id || post.author}` : `user:${post.creator_wallet || post.author}`, post])).values()).slice(0, 5).map((post) => {
      const collection = post.author_type === 'collection' ? allCollections.find((item) => item.id === post.collection_id) ?? (post.collection_id ? collectionFor(post.collection_id) : null) : null
      const name = collection?.name || publicPostAuthorName(post)
      return <button key={`${post.author_type}:${post.collection_id || post.creator_wallet || post.author}`} onClick={() => {
        if (collection) onCollection(collection)
        else if (post.author_type === 'user') onCreator(post.creator_wallet || post.author)
      }}><Avatar src={collection?.cover || post.avatar} alt={name} size="md" /><span className="desktop-suggestions__copy"><b>{name}</b><small>{collection ? 'Collection' : 'Suggested creator'}</small></span><em>{collection ? 'View' : 'Profile'}</em></button>
    })}{!posts.length && allCollections.slice(0, 5).map((collection) => <button key={collection.id} onClick={() => onCollection(collection)}><Avatar src={collection.cover} alt={collection.name} size="md" /><span className="desktop-suggestions__copy"><b>{collection.name}</b><small>{collection.items} collectibles</small></span><em>View</em></button>)}<footer>About · Help · Privacy · Terms<br />© 2026 StellaNova</footer></aside>
  </div>
}
function ExploreView({ allCollections, items, activeListings, onBulkBuy, onOpen, saved, toggleSaved, activeFilter, setActiveFilter, marketTab, setMarketTab, sortBy, setSortBy, onCreator, onCollection, onSell, liked, disliked, onLike, onDislike }: { allCollections: Collection[]; items: NFT[]; activeListings: MarketplaceListing[]; onBulkBuy: (items: NFT[]) => void; onOpen: (item: NFT) => void; saved: string[]; toggleSaved: (id: string) => void; activeFilter: string; setActiveFilter: (filter: string) => void; marketTab: MarketTab; setMarketTab: (tab: MarketTab) => void; sortBy: string; setSortBy: (sort: string) => void; onCreator: (id: string) => void; onCollection: (item: Collection) => void; onSell: (item: NFT) => void; liked: string[]; disliked: string[]; onLike: (id: string) => void; onDislike: (id: string) => void }) {
  const [selectedForCheckout, setSelectedForCheckout] = useState<string[]>([])
  const [collectionFilter, setCollectionFilter] = useState('')
  const [traitFilter, setTraitFilter] = useState('')
  const [traitValueFilter, setTraitValueFilter] = useState('')
  const [minimumPrice, setMinimumPrice] = useState('')
  const [maximumPrice, setMaximumPrice] = useState('')
  const collectionsInResults = allCollections.filter((collection) => items.some((item) => item.collectionId === collection.id))
  const traitTypes = [...new Set(items.flatMap((item) => item.attributes?.map((attribute) => attribute.trait_type) ?? []))].sort()
  const traitValues = traitFilter ? [...new Set(items.flatMap((item) => item.attributes?.filter((attribute) => attribute.trait_type === traitFilter).map((attribute) => String(attribute.value)) ?? []))].sort() : []
  const visibleItems = items.filter((item) => {
    if (collectionFilter && item.collectionId !== collectionFilter) return false
    if (traitFilter && !item.attributes?.some((attribute) => attribute.trait_type === traitFilter && (!traitValueFilter || String(attribute.value) === traitValueFilter))) return false
    const price = Number.parseFloat(item.price.replace(/[^\d.]/g, ''))
    if (minimumPrice && (!Number.isFinite(price) || price < Number(minimumPrice))) return false
    if (maximumPrice && (!Number.isFinite(price) || price > Number(maximumPrice))) return false
    return true
  })
  const selectable = visibleItems.filter((item) => activeListings.some((listing) => listing.nft_contract.toLowerCase() === item.contractId?.toLowerCase() && listing.token_id === item.tokenId && listing.listing_id >= 0))
  const selected = selectable.filter((item) => selectedForCheckout.includes(item.id)).slice(0, 10)
  return <div className="page"><section className="page-heading page--heading-compact"><div><span className="eyebrow">STELLAR TESTNET</span><h1>Explore NFTs.</h1></div></section><div className="market-tabs" role="tablist">{marketTabs.map((tab) => <button role="tab" aria-selected={marketTab === tab} className={`market-tab ${marketTab === tab ? 'is-active' : ''}`} key={tab} onClick={() => setMarketTab(tab)}>{tab}</button>)}</div><div className="market-filter-controls" aria-label="Filter marketplace"><label>Collection<select value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)}><option value="">All collections</option>{collectionsInResults.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></label><label>Trait<select value={traitFilter} onChange={(event) => { setTraitFilter(event.target.value); setTraitValueFilter('') }}><option value="">All traits</option>{traitTypes.map((trait) => <option key={trait} value={trait}>{trait}</option>)}</select></label>{traitFilter && <label>Value<select value={traitValueFilter} onChange={(event) => setTraitValueFilter(event.target.value)}><option value="">All values</option>{traitValues.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}<label>Min XLM<input type="number" min="0" step="any" value={minimumPrice} onChange={(event) => setMinimumPrice(event.target.value)} placeholder="Any" /></label><label>Max XLM<input type="number" min="0" step="any" value={maximumPrice} onChange={(event) => setMaximumPrice(event.target.value)} placeholder="Any" /></label><label>Sort by<select value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option>Relevance</option><option>Newest</option><option>Price low</option><option>Price high</option><option>Ending soon</option></select></label></div><div className="explore-meta"><span><b>{visibleItems.length}</b> NFTs</span></div>{selectable.length > 0 && <section className="bulk-checkout"><div><b>Buy multiple NFTs in one transaction</b><small>Select up to 10 listed works. The purchase succeeds for all selected NFTs or none.</small></div><Button onClick={() => { onBulkBuy(selected); setSelectedForCheckout([]) }} disabled={!selected.length}>{selected.length ? `Buy ${selected.length} NFT${selected.length === 1 ? '' : 's'}` : 'Select NFTs'}</Button></section>}{visibleItems.length ? <div className="feed-grid feed-grid--explore">{visibleItems.map((item) => { const isListed = selectable.some((entry) => entry.id === item.id); return <div className="explore-card-wrap" key={item.id}>{isListed && <label className="explore-card-select"><input type="checkbox" checked={selectedForCheckout.includes(item.id)} disabled={!selectedForCheckout.includes(item.id) && selectedForCheckout.length >= 10} onChange={(event) => setSelectedForCheckout((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><span>Select for bulk checkout</span></label>}<ArtworkCard item={item} collectionOverride={allCollections.find((collection) => collection.id === item.collectionId)} saved={saved.includes(item.id)} onSave={() => toggleSaved(item.id)} onOpen={() => onOpen(item)} onCreator={() => onCreator(item.creatorId)} onCollection={() => onCollection(allCollections.find((collection) => collection.id === item.collectionId) ?? collectionFor(item.collectionId))} liked={liked.includes(item.id)} disliked={disliked.includes(item.id)} onLike={() => onLike(item.id)} onDislike={() => onDislike(item.id)} onSell={() => onSell(item)} /></div> })}</div> : <div className="empty-state"><h3>No NFTs match these filters.</h3><p>Adjust the collection, trait, or price range.</p></div>}</div>
}

function AnalyticsView({ walletAddress = '', isAdmin = false }: { walletAddress?: string; isAdmin?: boolean }) {
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [chartMetric, setChartMetric] = useState<'mints' | 'volume_xlm'>('mints')
  const [shareMessage, setShareMessage] = useState('')
  const [opsHealth, setOpsHealth] = useState<Awaited<ReturnType<typeof fetchOpsHealth>> | null>(null)
  const [opsReconciliation, setOpsReconciliation] = useState<Awaited<ReturnType<typeof fetchOpsReconciliation>> | null>(null)
  const [opsBusy, setOpsBusy] = useState(false)
  const [opsError, setOpsError] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setSnapshot(await fetchAnalyticsOverview()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Analytics are temporarily unavailable') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const loadOperations = useCallback(async () => {
    if (!isAdmin || !walletAddress) return
    setOpsError('')
    try {
      const [health, reconciliation] = await Promise.all([fetchOpsHealth(walletAddress), fetchOpsReconciliation(walletAddress)])
      setOpsHealth(health)
      setOpsReconciliation(reconciliation)
    } catch (cause) { setOpsError(cause instanceof Error ? cause.message : 'Operations dashboard could not load') }
  }, [isAdmin, walletAddress])
  useEffect(() => { void loadOperations() }, [loadOperations])
  const recoverOwnership = async () => {
    if (!walletAddress) return
    setOpsBusy(true)
    setOpsError('')
    try {
      const result = await runOpsReconciliation(walletAddress)
      setOpsError(`Recovery completed: ${result.checked} ownership checks, ${result.repaired} owners repaired, ${result.metadataRepaired ?? 0} metadata records restored, ${result.failed + (result.metadataFailed ?? 0)} checks failed.`)
      await loadOperations()
    } catch (cause) { setOpsError(cause instanceof Error ? cause.message : 'Reconciliation drill failed') }
    finally { setOpsBusy(false) }
  }
  const shareSnapshot = async () => {
    if (!snapshot) return
    const week = snapshot.daily.slice(-7)
    const minted = week.reduce((total, day) => total + day.mints, 0)
    const volume = week.reduce((total, day) => total + Number(day.volume_xlm || 0), 0)
    const text = `StellaNova · 7-day Stellar Testnet snapshot\n${minted.toLocaleString()} NFTs minted · ${snapshot.summary.sales.toLocaleString()} completed marketplace sales all-time · ${volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM total volume this week (paid mints + completed trades)\n${snapshot.summary.collections.toLocaleString()} collections · ${snapshot.summary.holders.toLocaleString()} wallet holders\n${window.location.origin}/analytics`
    setShareMessage('')
    try {
      if (navigator.share) await navigator.share({ title: 'StellaNova marketplace snapshot', text })
      else { await navigator.clipboard.writeText(text); setShareMessage('Snapshot copied. Paste it into your social post.') }
    } catch (cause) {
      if (cause instanceof Error && cause.name !== 'AbortError') setShareMessage('Could not open sharing. Copy the page link from your browser.')
    }
  }
  const summary = snapshot?.summary
  const maxValue = snapshot ? Math.max(1, ...snapshot.daily.map((day) => chartMetric === 'mints' ? day.mints : Number(day.volume_xlm))) : 1
  const metricCards = summary ? [
    { label: 'NFTs minted', value: summary.minted.toLocaleString(), detail: 'Confirmed on Stellar Testnet', icon: 'image' as const },
    { label: 'Collections', value: summary.collections.toLocaleString(), detail: 'Deployed collection contracts', icon: 'grid' as const },
    { label: 'Wallet holders', value: summary.holders.toLocaleString(), detail: 'Wallets holding indexed NFTs', icon: 'user' as const },
    { label: 'Completed trades', value: summary.sales.toLocaleString(), detail: 'Listings, accepted offers, and auctions', icon: 'activity' as const },
    { label: 'Total volume', value: `${Number(summary.volume_xlm).toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM`, detail: 'Paid mints + completed trades', icon: 'wallet' as const },
    { label: 'Primary mint volume', value: `${Number(summary.primary_volume_xlm).toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM`, detail: 'Verified amount paid at mint', icon: 'image' as const },
    { label: 'Marketplace trade volume', value: `${Number(summary.secondary_volume_xlm).toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM`, detail: 'Completed listing, offer, and auction sales', icon: 'activity' as const },
    { label: 'Open listings', value: summary.listings.toLocaleString(), detail: 'Listings currently indexed as active', icon: 'bookmark' as const },
  ] : []
  return <div className="page page--analytics">
    <section className="page-heading page-heading--compact analytics-heading"><div><span className="eyebrow">PUBLIC MARKET SNAPSHOT · STELLAR TESTNET</span><h1>Analytics.</h1><p>Real activity from confirmed mints and indexed marketplace trades.</p></div><Button onClick={() => void shareSnapshot()} disabled={!snapshot}><Icon name="share" size={15} />Share snapshot</Button></section>
    {shareMessage && <p className="analytics-share-status" role="status">{shareMessage}</p>}
    {loading && !snapshot && <div className="empty-state"><h3>Loading marketplace data…</h3></div>}
    {error && <div className="empty-state analytics-error"><h3>Analytics could not load.</h3><p>{error}</p><Button variant="outline" onClick={() => void load()}>Try again</Button></div>}
    {summary && snapshot && <>
      <div className="analytics-meta"><span><i /> Live indexed snapshot</span><small>Updated {new Date(snapshot.generatedAt).toLocaleString()}</small></div>
      <section className="analytics-stat-grid" aria-label="Marketplace totals">{metricCards.map((metric) => <article className="analytics-stat" key={metric.label}><span className="analytics-stat__icon"><Icon name={metric.icon} size={18} /></span><small>{metric.label}</small><strong>{metric.value}</strong><span>{metric.detail}</span></article>)}</section>
      {isAdmin && <section className="analytics-panel ops-dashboard" aria-label="Operations and transaction reconciliation"><div className="section-title"><div><span className="eyebrow">ADMIN OPERATIONS</span><h3>System health & reconciliation</h3></div><Button variant="outline" onClick={() => void recoverOwnership()} disabled={opsBusy}>{opsBusy ? 'Checking chain…' : 'Run recovery check'}</Button></div>{opsError && <p className="ops-dashboard__error" role="status">{opsError}</p>}{opsHealth && <div className="ops-dashboard__health"><span className={opsHealth.components.database.ok ? 'is-good' : 'is-bad'}>Database {opsHealth.components.database.ok ? 'healthy' : 'down'}</span><span className={opsHealth.components.sorobanRpc.ok ? 'is-good' : 'is-bad'}>Soroban RPC {opsHealth.components.sorobanRpc.ok ? 'healthy' : 'down'}</span><span className={opsHealth.components.indexer.ok ? 'is-good' : 'is-bad'}>Indexer {opsHealth.components.indexer.ok ? 'healthy' : 'behind'}</span><span>Email alerts {opsHealth.alert.emailConfigured ? 'ready' : 'not configured'}</span><span>Webhook alerts {opsHealth.alert.webhookConfigured ? 'ready' : 'not configured'}</span><span>Last delivery: {opsHealth.alert.lastResult}</span></div>}{opsReconciliation && <><div className="ops-dashboard__summary"><div><small>Confirmed mints</small><b>{opsReconciliation.summary.confirmed_mints}</b></div><div><small>Missing owner projection</small><b>{opsReconciliation.summary.missing_owner_projection}</b></div><div><small>Missing NFT metadata projection</small><b>{opsReconciliation.summary.missing_metadata_projection}</b></div><div><small>Last ledger seen</small><b>{opsReconciliation.summary.latest_ledger ?? '—'}</b></div></div><h4>Recent confirmed mint transactions</h4><div className="ops-dashboard__table-wrap"><table className="ops-dashboard__table"><thead><tr><th>Transaction</th><th>Token</th><th>Ledger</th><th>Owner</th><th>Metadata</th></tr></thead><tbody>{opsReconciliation.recentTransactions.map((tx) => <tr key={`${tx.tx_hash}:${tx.token_id}`}><td><code title={tx.tx_hash}>{tx.tx_hash.slice(0, 8)}…{tx.tx_hash.slice(-6)}</code></td><td title={tx.contract_id}>#{tx.token_id}</td><td>{tx.ledger}</td><td>{tx.owner_projected ? 'Indexed' : 'Missing'}</td><td>{tx.metadata_projected ? 'Indexed' : 'Missing'}</td></tr>)}</tbody></table></div>{opsReconciliation.recoveryRuns[0] && <p className="analytics-note">Last recovery check: {opsReconciliation.recoveryRuns[0].repaired} owner records repaired · {opsReconciliation.recoveryRuns[0].metadata_repaired} metadata records restored · {opsReconciliation.recoveryRuns[0].failed + opsReconciliation.recoveryRuns[0].metadata_failed} failed checks · {new Date(opsReconciliation.recoveryRuns[0].created_at).toLocaleString()}</p>}</>}</section>}
      <section className="analytics-panel analytics-trend"><div className="section-title"><div><span className="eyebrow">LAST 30 DAYS</span><h3>Marketplace activity</h3></div><div className="analytics-tabs" role="tablist" aria-label="Chart metric"><button className={chartMetric === 'mints' ? 'is-active' : ''} onClick={() => setChartMetric('mints')} role="tab" aria-selected={chartMetric === 'mints'}>NFTs minted</button><button className={chartMetric === 'volume_xlm' ? 'is-active' : ''} onClick={() => setChartMetric('volume_xlm')} role="tab" aria-selected={chartMetric === 'volume_xlm'}>Total volume</button></div></div><div className="analytics-chart" role="img" aria-label={`Daily ${chartMetric === 'mints' ? 'confirmed mints' : 'total volume from paid mints and completed trades in XLM'} for the last 30 days`}>{snapshot.daily.map((day) => { const value = chartMetric === 'mints' ? day.mints : Number(day.volume_xlm); return <span className="analytics-chart__column" key={day.day} title={`${day.day}: ${chartMetric === 'mints' ? value : `${value.toLocaleString()} XLM total (${Number(day.primary_volume_xlm).toLocaleString()} mint + ${Number(day.secondary_volume_xlm).toLocaleString()} trade)`}`}><i style={{ height: `${Math.max(3, value / maxValue * 100)}%` }} /></span> })}</div><div className="analytics-chart__labels"><span>{snapshot.daily[0]?.day}</span><span>Daily totals · 30 days</span><span>{snapshot.daily[snapshot.daily.length - 1]?.day}</span></div></section>
      <section className="analytics-panel analytics-top"><div className="section-title"><div><span className="eyebrow">BY CONFIRMED MINTS</span><h3>Top collections</h3></div></div>{snapshot.topCollections.length ? <div className="analytics-top__list">{snapshot.topCollections.map((collection, index) => <div className="analytics-top__row" key={collection.collection_id}><b className="analytics-top__rank">{String(index + 1).padStart(2, '0')}</b>{collection.cover ? <img src={mediaSource(collection.cover)} alt="" /> : <span className="analytics-top__placeholder"><Icon name="grid" size={17} /></span>}<span><strong>{collection.name}</strong><small>{collection.collection_id}</small></span><b>{collection.minted.toLocaleString()} <small>NFTs</small></b></div>)}</div> : <div className="analytics-empty">No confirmed collection mints have been indexed yet.</div>}</section>
      <p className="analytics-footnote">Volume includes paid primary mints and completed marketplace trades (including accepted offers and auction sales). Open, rejected, cancelled, and expired offers do not count. Exact mint payment data is available for mints recorded after the updated NFT contract is deployed; older mint events did not record payment amounts and are excluded rather than estimated.</p>
    </>}
  </div>
}

function CollectionsView({ collections, posts, allNfts, walletAddress, onOpen, onOpenNft, onCreator, onBuyNft, onOfferNft, onPostLike, onPostDislike, onPostComment, disliked, subscribedCollections, onSubscribe, collectionSocial, onCollectionReaction, onCollectionComment }: { collections: Collection[]; posts: PostRecord[]; allNfts: NFT[]; walletAddress: string; onOpen: (item: Collection) => void; onOpenNft: (item: NFT) => void; onCreator: (creatorId: string) => void; onBuyNft: (item: NFT) => void; onOfferNft: (item: NFT) => void; onPostLike: (id: number) => void; onPostDislike: (id: number) => void; onPostComment: (id: number, text: string, parentId?: number | string | null) => Promise<void>; disliked: string[]; subscribedCollections: string[]; onSubscribe: (collection: Collection) => void; collectionSocial: Record<string, CollectionSocialRecord>; onCollectionReaction: (collectionId: string, reaction: 'like' | 'dislike') => void; onCollectionComment: (collectionId: string, text: string, parentId?: number | string | null) => Promise<void> }) {
  const publicCollections = collections.filter((collection) => !collection.isSample)
  const [collectionFilter, setCollectionFilter] = useState<'all' | 'minting'>('all')
  const mintingCount = publicCollections.filter((collection) => collection.mintingNow).length
  const visibleCollections = collectionFilter === 'minting'
    ? publicCollections.filter((collection) => collection.mintingNow)
    : publicCollections
  const collectionPosts = posts.filter((post) => post.author_type === 'collection')
  return (
    <div className="page page--collections">
      <section className="page-heading page--heading-compact">
        <div><span className="eyebrow">STELLAR TESTNET</span><h1>Collections.</h1><p className="collections-intro">Discover collections, browse their works, and follow the ones you care about.</p></div>
        <span className="saved-count">{subscribedCollections.length} following</span>
      </section>
      {collectionPosts.length > 0 && <section className="collections-feed section-block">
        <div className="section-title"><div><span className="eyebrow">COLLECTION UPDATES</span><h3>From the collections</h3></div></div>
        <div className="collections-feed__posts">{collectionPosts.map((post) => <PostCard key={`collection-post-${post.id}`} post={post} allNfts={allNfts} onLike={onPostLike} onDislike={onPostDislike} disliked={disliked.includes(`post:${post.id}`)} onComment={onPostComment} onOpenNft={(nftId) => { const item = allNfts.find((nft) => nft.id === nftId); if (item) onOpenNft(item) }} onCreator={onCreator} onCollection={onOpen} collections={collections} walletAddress={walletAddress} onBuyNft={onBuyNft} onOfferNft={onOfferNft} />)}</div>
      </section>}
      {publicCollections.length ? <section className="collections-discover">
        <div className="section-title">
          <div><span className="eyebrow">DISCOVER</span><h3>Browse collections</h3></div>
          <span className="muted-note">{visibleCollections.length} of {publicCollections.length} collections</span>
        </div>
        <div className="collection-filter-tabs" role="tablist" aria-label="Filter collections">
          <button type="button" role="tab" aria-selected={collectionFilter === 'all'} className={collectionFilter === 'all' ? 'is-active' : ''} onClick={() => setCollectionFilter('all')}>All <span>{publicCollections.length}</span></button>
          <button type="button" role="tab" aria-selected={collectionFilter === 'minting'} className={collectionFilter === 'minting' ? 'is-active' : ''} onClick={() => setCollectionFilter('minting')}>Minting <span>{mintingCount}</span></button>
        </div>
        {visibleCollections.length ? <div className="collection-list">{visibleCollections.map((collection) => <article className="post-card collection-discovery-card" key={collection.id}>
          <div className="post-card__head"><Avatar src={collection.cover} alt={collection.name} size="sm" /><div><strong>{collection.name || 'Untitled collection'}</strong><span className="collection-discovery-card__meta">{collection.symbol ? `${collection.symbol} · ` : ''}{collection.items || '0'} NFTs{collection.mintingNow ? ' · Minting now' : ''}</span></div></div>
          <button className="collection-discovery-card__media" onClick={() => onOpen(collection)} aria-label={`View ${collection.name} collection`}>{collection.mintingNow && <span className="collection-minting-badge"><span />Minting now</span>}<CollectionCover cover={collection.cover} name={collection.name} symbol={collection.symbol} className="collection-card__cover" /></button>
          <div className="post-card__body collection-discovery-card__body">{collection.description && <p>{collection.description}</p>}</div>
          <CollectionSocialActions collectionId={collection.id} social={collectionSocial[collection.id]} onReaction={onCollectionReaction} onComment={onCollectionComment} />
          <div className="collection-discovery-card__actions"><button className={`collection-follow-button ${subscribedCollections.includes(collection.id) ? 'is-following' : ''}`} onClick={() => onSubscribe(collection)}><Icon name="heart" size={15} />{subscribedCollections.includes(collection.id) ? 'Following' : 'Follow collection'}</button><button className="collection-discovery-card__view" onClick={() => onOpen(collection)}>View collection <Icon name="arrow" size={14} /></button></div>
        </article>)}</div> : <div className="empty-state empty-state--compact"><h3>No collections minting right now.</h3><p>Switch to All to browse every collection.</p><Button variant="outline" onClick={() => setCollectionFilter('all')}>Show all collections</Button></div>}
      </section> : <div className="empty-state"><h3>No collections yet.</h3><p>Collections created on StellaNova will appear here.</p></div>}
    </div>
  )
}

function CollectionSocialActions({ collectionId, social, onReaction, onComment }: { collectionId: string; social?: CollectionSocialRecord; onReaction: (collectionId: string, reaction: 'like' | 'dislike') => void; onComment: (collectionId: string, text: string, parentId?: number | string | null) => Promise<void> }) {
  const [commentsOpen, setCommentsOpen] = useState(false)
  const comments = social?.comments ?? []
  return <div className="collection-discovery-card__social"><div className="post-card__actions">
    <button className={social?.liked ? 'is-active-up' : ''} onClick={() => onReaction(collectionId, 'like')} aria-label="Like collection" title="Like"><Icon name="thumbUp" size={19} /><span>{social?.likes ?? 0}</span></button>
    <button className={social?.disliked ? 'is-active-down' : ''} onClick={() => onReaction(collectionId, 'dislike')} aria-label="Dislike collection" title="Dislike"><Icon name="thumbDown" size={19} /><span>{social?.dislikes ?? 0}</span></button>
    <button className={commentsOpen ? 'is-active-up' : ''} onClick={() => setCommentsOpen((open) => !open)} aria-label="View collection comments" title="Comments"><Icon name="comment" size={19} /><span>{comments.length}</span></button>
  </div>{commentsOpen && <><ThreadedCommentList comments={comments} onReply={(parentId, body) => onComment(collectionId, body, parentId)} /><form className="post-card__comment" onSubmit={async (event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('body') as HTMLInputElement; if (!input.value.trim()) return; await onComment(collectionId, input.value); input.value = '' }}><input name="body" placeholder="Add a comment…" aria-label="Add a collection comment" /><button type="submit">Post</button></form></>}</div>
}
function SavedView({ allCollections, saved, items, onOpen, toggleSaved, onCollection, onSell, liked, disliked, onLike, onDislike }: { allCollections: Collection[]; saved: string[]; items: NFT[]; onOpen: (item: NFT) => void; toggleSaved: (id: string) => void; onCollection: (item: Collection) => void; onSell: (item: NFT) => void; liked: string[]; disliked: string[]; onLike: (id: string) => void; onDislike: (id: string) => void }) {
  return <div className="page"><section className="page-heading page-heading--compact"><div><span className="eyebrow">YOUR PICKS</span><h1>Saved for<br /><i>later.</i></h1></div><span className="saved-count">{saved.length.toString().padStart(2, '0')} saved</span></section>{items.length ? <div className="feed-grid feed-grid--saved">{items.map((item) => <ArtworkCard item={item} collectionOverride={allCollections.find((collection) => collection.id === item.collectionId)} key={item.id} saved onSave={() => toggleSaved(item.id)} onOpen={() => onOpen(item)} onCreator={() => undefined} onCollection={() => onCollection(allCollections.find((collection) => collection.id === item.collectionId) ?? collectionFor(item.collectionId))} liked={liked.includes(item.id)} disliked={disliked.includes(item.id)} onLike={() => onLike(item.id)} onDislike={() => onDislike(item.id)} onSell={() => onSell(item)} />)}</div> : <div className="empty-state"><span className="empty-state__icon"><Icon name="bookmark" size={24} /></span><h3>Your picks are waiting.</h3><p>Tap the bookmark on any artwork to keep it close.</p></div>}</div>
}

type PublicProfileInput = { displayName: string; creatorUsername: string; bio: string; avatar: string; avatarFile: File | null }

function CreatorProfileSettingsModal({ account, ownedNfts, posts, walletCollections, walletAddress, onSaveProfile, onClose }: { account: UserAccount | null; ownedNfts: NFT[]; posts: PostRecord[]; walletCollections: WalletCollection[]; walletAddress: string; onSaveProfile: (profile: PublicProfileInput) => Promise<void>; onClose: () => void }) {
  const [displayName, setDisplayName] = useState(account?.display_name ?? '')
  const [username, setUsername] = useState(account?.creator_username ?? '')
  const [bio, setBio] = useState(account?.bio ?? '')
  const [avatar, setAvatar] = useState(account?.avatar ?? '')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState('')
  const normalizedUsername = username.trim().replace(/^@/, '').toLowerCase()
  const usernameValid = !normalizedUsername || /^[a-z][a-z0-9_]{2,23}$/.test(normalizedUsername)
  const avatarChoices = [
    ...ownedNfts.filter((item) => item.image).map((item) => ({ image: item.image, label: item.title, kind: 'NFT' })),
    ...posts.filter((post) => (post.is_me || post.creator_wallet?.toLowerCase() === walletAddress.toLowerCase() || post.author.toLowerCase() === walletAddress.toLowerCase()) && post.media_url && post.media_type === 'image')
      .map((post) => ({ image: post.media_url, label: post.caption.trim() || 'Shared artwork', kind: 'Your artwork' })),
    ...walletCollections.filter((collection) => collection.cover).map((collection) => ({ image: collection.cover, label: collection.name, kind: 'Collection' })),
  ].filter((choice, index, all) => all.findIndex((candidate) => candidate.image === choice.image) === index)
  useEffect(() => {
    if (!avatarFile) { setPreview(''); return }
    const url = URL.createObjectURL(avatarFile)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [avatarFile])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await onSaveProfile({ displayName: displayName.trim(), creatorUsername: normalizedUsername, bio: bio.trim(), avatar, avatarFile })
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save your profile.')
    } finally {
      setSaving(false)
    }
  }
  return <div className="modal-backdrop profile-edit-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="profile-edit-modal" role="dialog" aria-modal="true" aria-labelledby="profile-edit-title">
    <header className="profile-edit-modal__header"><div><span className="eyebrow">ACCOUNT SETTINGS</span><h2 id="profile-edit-title">Edit profile</h2><p>Update how people see you across the feed and your creator profile.</p></div><button className="profile-edit-modal__close" type="button" onClick={onClose} aria-label="Close profile settings"><Icon name="close" size={18} /></button></header>
    <form className="profile-edit-form" onSubmit={(event) => void save(event)}>
      <div className="profile-edit-photo"><div className="profile-edit-photo__preview">{preview || avatar ? <img src={preview || avatar} alt="Profile preview" /> : <Icon name="user" size={25} />}</div><div><strong>Profile photo</strong><small>JPG, PNG, WebP, or GIF · up to 10 MB</small><label className="profile-edit-photo__button">{avatarFile ? 'Choose a different photo' : 'Upload photo'}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024)) { setError('Choose an image that is 10 MB or smaller.'); event.target.value = ''; return } setError(''); setAvatar(''); setAvatarFile(file) }} /></label></div>{(avatarFile || avatar) && <button className="profile-edit-photo__remove" type="button" onClick={() => { setAvatarFile(null); setAvatar('') }}>Remove</button>}</div>
      {avatarChoices.length > 0 && <section className="profile-avatar-picker" aria-label="Choose a profile photo from your work"><div><strong>Or choose from your work</strong><small>Your NFTs, shared artworks, and collection covers.</small></div><div className="profile-avatar-picker__grid">{avatarChoices.map((choice) => <button type="button" key={`${choice.kind}:${choice.image}`} className={`profile-avatar-picker__choice ${avatar === choice.image && !avatarFile ? 'is-selected' : ''}`} aria-label={`Use ${choice.label} as profile photo`} aria-pressed={avatar === choice.image && !avatarFile} onClick={() => { setError(''); setAvatarFile(null); setAvatar(choice.image) }}><img src={choice.image} alt="" loading="lazy" /><span><small>{choice.kind}</small><b>{choice.label}</b></span></button>)}</div></section>}
      <label className="profile-edit-field"><span>Display name</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" autoComplete="name" /></label>
      <label className="profile-edit-field"><span>Username</span><div className="profile-edit-username"><b>@</b><input value={username} maxLength={24} onChange={(event) => setUsername(event.target.value)} placeholder="yourname" autoComplete="off" /></div><small>Unique, public handle. 3–24 characters; letters, numbers, and underscores.</small></label>
      <label className="profile-edit-field"><span>Bio</span><textarea value={bio} maxLength={500} rows={4} onChange={(event) => setBio(event.target.value)} placeholder="Tell people a little about yourself." /><small>{bio.length}/500</small></label>
      {error && <p className="profile-edit-error" role="alert">{error}</p>}
      <footer className="profile-edit-actions"><button className="profile-edit-cancel" type="button" onClick={onClose}>Cancel</button><Button type="submit" disabled={!usernameValid || saving}>{saving ? 'Saving…' : 'Save changes'}</Button></footer>
    </form>
  </section></div>
}

function FeedbackView() {
  const [entries, setEntries] = useState<PublicFeedbackEntry[]>([])
  const [category, setCategory] = useState<PublicFeedbackEntry['category']>('idea')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const reload = useCallback(() => {
    setError('')
    setLoading(true)
    void fetchPublicFeedback().then(setEntries).catch((cause) => setError(cause instanceof Error ? cause.message : 'Feedback could not be loaded.')).finally(() => setLoading(false))
  }, [])
  useEffect(() => { reload() }, [reload])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true); setError(''); setSuccess('')
    try {
      const entry = await submitPublicFeedback({ category, title, body })
      setEntries((current) => [entry, ...current].slice(0, 100))
      setTitle(''); setBody(''); setSuccess('Thanks — your feedback is now visible to the community.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Feedback could not be submitted.') }
    finally { setSubmitting(false) }
  }
  const statusLabel = (status: PublicFeedbackEntry['status']) => ({ new: 'New', planned: 'Planned', in_progress: 'In progress', done: 'Done' })[status]
  return <div className="page feedback-page">
    <section className="page-heading"><div><span className="eyebrow">STELLANOVA · COMMUNITY</span><h1>Help shape<br /><i>what comes next.</i></h1><p>Share an idea, report a problem, or tell us what is working. Submissions are public so everyone can follow the conversation.</p></div></section>
    <div className="feedback-layout">
      <form className="feedback-form section-block" onSubmit={(event) => void submit(event)}>
        <span className="eyebrow">YOUR FEEDBACK</span><h2>What should we know?</h2>
        <label className="feedback-field"><span>Type</span><select value={category} onChange={(event) => setCategory(event.target.value as PublicFeedbackEntry['category'])}><option value="idea">Idea</option><option value="problem">Problem</option><option value="praise">Praise</option></select></label>
        <label className="feedback-field"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} maxLength={120} required placeholder="A short summary" /></label>
        <label className="feedback-field"><span>Details</span><textarea value={body} onChange={(event) => setBody(event.target.value)} minLength={10} maxLength={2000} required rows={6} placeholder="Describe your idea or what happened…" /><small>{body.length}/2,000</small></label>
        {error && <p className="feedback-message is-error" role="alert">{error}</p>}{success && <p className="feedback-message is-success" role="status">{success}</p>}
        <Button type="submit" disabled={submitting || title.trim().length < 4 || body.trim().length < 10}>{submitting ? 'Submitting…' : 'Post feedback'} <Icon name="arrow" size={15} /></Button>
        <p className="muted-note">No account or email required. Please don’t include private information. You can post up to five submissions per hour.</p>
      </form>
      <section className="feedback-board section-block">
        <div className="section-title"><div><span className="eyebrow">COMMUNITY BOARD</span><h2>Recent feedback</h2></div><button className="feedback-refresh" type="button" onClick={reload} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button></div>
        {loading ? <p className="muted-note">Loading feedback…</p> : error && !entries.length ? <div className="empty-state empty-state--compact"><h3>Feedback could not be loaded.</h3><p>{error}</p><Button variant="outline" onClick={reload}>Try again</Button></div> : entries.length ? <div className="feedback-list">{entries.map((entry) => <article className="feedback-entry" key={entry.id}><div className="feedback-entry__meta"><span className={`feedback-category feedback-category--${entry.category}`}>{entry.category === 'problem' ? 'Problem' : entry.category === 'praise' ? 'Praise' : 'Idea'}</span><span className={`feedback-status feedback-status--${entry.status}`}>{statusLabel(entry.status)}</span><time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleDateString()}</time></div><h3>{entry.title}</h3><p>{entry.body}</p></article>)}</div> : <div className="empty-state empty-state--compact"><h3>No feedback yet.</h3><p>Be the first to share an idea or report an issue.</p></div>}
      </section>
    </div>
  </div>
}

function SettingsView({ feedPreferences, setFeedPreferences }: { feedPreferences: FeedPreferences; setFeedPreferences: (preferences: FeedPreferences) => void }) {
  const options: [keyof FeedPreferences, string, string][] = [
    ['creatorPosts', 'Creator posts', 'People sharing updates and artwork.'],
    ['collectibles', 'Collectibles', 'New NFT cards in the same timeline.'],
  ]
  return <div className="page page--settings"><section className="page-heading page-heading--compact"><div><span className="eyebrow">YOUR EXPERIENCE</span><h1>Settings.</h1></div></section><section className="settings-panel"><div className="settings-panel__heading"><span className="settings-panel__icon"><Icon name="filter" size={19} /></span><div><h2>Feed content</h2><p>Choose what to include. Everything stays together in one timeline.</p></div></div><div className="settings-options" aria-label="Feed content preferences">{options.map(([key, title, description]) => <button key={key} role="switch" aria-checked={feedPreferences[key]} className={`settings-option ${feedPreferences[key] ? 'is-active' : ''}`} onClick={() => setFeedPreferences({ ...feedPreferences, [key]: !feedPreferences[key] })}><span className={`settings-toggle ${feedPreferences[key] ? 'is-on' : ''}`}><i /></span><span><b>{title}</b><small>{description}</small></span></button>)}</div></section><p className="settings-note">Your choices are saved on this device. The feed remains a mixed, chronological timeline.</p></div>
}

function formatOfferXlm(stroops: string) { return formatTokenAmount(stroops, 7) }
function formatMarketplaceAmount(units: string, token?: string) {
  const asset = stellarPaymentAssets.find((candidate) => candidate.contractId.toLowerCase() === token?.toLowerCase())
  return `${formatTokenAmount(units, asset?.decimals ?? 7)} ${asset?.code ?? 'XLM'}`
}
function formatMarketplaceNumber(units: string, token?: string) {
  const asset = stellarPaymentAssets.find((candidate) => candidate.contractId.toLowerCase() === token?.toLowerCase())
  return formatTokenAmount(units, asset?.decimals ?? 7)
}
function formatTokenAmount(units: string, decimals: number) {
  const value = Number(units) / 10 ** decimals
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals })
}
function assetAmountToUnits(input: string, decimals: number): bigint {
  const value = input.trim()
  if (!/^\d+(?:\.\d*)?$/.test(value)) throw new Error('Enter a valid positive token amount')
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) throw new Error(`This token supports at most ${decimals} decimal places`)
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction || '').padEnd(decimals, '0') || '0')
}
function formatOfferExpiry(expiresAt: number) {
  const remaining = Math.max(0, expiresAt * 1000 - Date.now())
  if (remaining <= 0) return 'Expired · cancel to reclaim escrow'
  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  return `Expires in ${hours}h ${minutes}m`
}

function MarketplaceIncomingOfferRow({ offer, onAccept, onReject, onCounter, item, onOpen }: { offer: MarketplaceOffer; onAccept: () => void; onReject: () => void; onCounter: (amount: string) => Promise<boolean | void> | boolean | void; item?: NFT; onOpen?: () => void }) {
  const [editing, setEditing] = useState(false)
  const [amount, setAmount] = useState(formatMarketplaceNumber(offer.amount, offer.payment_token))
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState<'accept' | 'cancel' | null>(null)
  const runOfferAction = async (action: 'accept' | 'cancel', callback: () => void) => { setActing(action); try { await callback() } finally { setActing(null) } }
  const countered = offer.response_status === 'countered'
  const expired = offer.expires_at * 1000 <= Date.now()
  const nftTitle = item?.title || offer.nft_title?.trim() || ''
  const nftImage = item?.image || offer.nft_image || ''
  const nftCollection = item ? collectionFor(item.collectionId).name : offer.nft_collection_id
  return <div className="offer-row-wrap"><div className="management-row management-row--offer"><span className="offer-row-copy">{(nftTitle || nftImage) && <button type="button" className="offer-nft-link" onClick={onOpen} disabled={!onOpen}><span className="offer-nft-thumb">{nftImage ? <img src={mediaSource(nftImage)} alt="" /> : <Icon name="image" size={18} />}</span><span><b>{nftTitle || `NFT #${offer.token_id}`}</b><small>{nftCollection ? `${nftCollection} · ` : ''}Token #{offer.token_id}</small></span>{onOpen && <Icon name="arrow" size={14} />}</button>}<b>Offer #{offer.offer_id}</b><small>Token #{offer.token_id} · {formatOfferXlm(offer.amount)} XLM · from {offer.buyer ? shortenStellarAddress(offer.buyer) : 'buyer'} · {formatOfferExpiry(offer.expires_at)}{countered && offer.counter_amount ? ` · Countered at ${formatOfferXlm(offer.counter_amount)} XLM` : ''}</small></span><div className="offer-row-actions">{!expired && <><Button disabled={Boolean(acting)} onClick={() => void runOfferAction('accept', onAccept)}>{acting === 'accept' ? 'Accepting…' : 'Accept'}</Button><Button variant="outline" disabled={Boolean(acting)} onClick={() => setEditing((value) => !value)}>{countered ? 'Edit counter' : 'Counter'}</Button></>}<Button variant="quiet" disabled={Boolean(acting)} onClick={() => void runOfferAction('cancel', onReject)}>{acting === 'cancel' ? 'Refunding…' : expired ? 'Refund buyer' : 'Cancel offer'}</Button></div></div>{acting && <p className="offer-progress" role="status" aria-live="polite"><span className="offer-progress-spinner" aria-hidden="true" />{acting === 'accept' ? 'Accepting offer and waiting for Stellar confirmation…' : 'Cancelling offer and waiting for Stellar confirmation…'}</p>}<small className="offer-escrow-note">{expired ? 'This offer expired. Refund the buyer to release its escrow.' : 'Cancelling closes the offer on-chain and refunds the buyer’s escrow.'}</small>{editing && !expired && <form className="counter-offer-form" onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { const sent = await onCounter(amount); if (sent !== false) setEditing(false) } finally { setSaving(false) } }}><label>Counter amount in XLM<input type="number" min="0.0000001" step="0.0000001" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label><Button type="submit" disabled={saving}>{saving ? 'Sending…' : 'Send counter'}</Button></form>}</div>
}

function MarketplaceOutgoingOfferRow({ offer, onCancel, onCounterResponse }: { offer: MarketplaceOffer; onCancel: () => void; onCounterResponse: (accept: boolean) => void }) {
  const [acting, setActing] = useState<'cancel' | 'accept' | 'reject' | null>(null)
  const run = async (action: 'cancel' | 'accept' | 'reject', callback: () => void) => { setActing(action); try { await callback() } finally { setActing(null) } }
  const status = offer.response_status
  const expired = offer.expires_at * 1000 <= Date.now()
  return <div className="offer-row-wrap"><div className="management-row management-row--offer"><span><b>Offer #{offer.offer_id}</b><small>Token #{offer.token_id} · {formatOfferXlm(offer.amount)} XLM escrowed · {formatOfferExpiry(offer.expires_at)}</small>{status === 'countered' && offer.counter_amount && <small className="offer-status">Counter-offer: {formatOfferXlm(offer.counter_amount)} XLM</small>}{status === 'counter_rejected' && <small className="offer-status offer-status--declined">Counter declined · cancel to reclaim escrow</small>}{status === 'counter_accepted' && <small className="offer-status">Counter accepted · replacement offer is being indexed</small>}</span><div className="offer-row-actions">{!expired && status === 'countered' && <><Button disabled={Boolean(acting)} onClick={() => void run('accept', () => onCounterResponse(true))}>{acting === 'accept' ? 'Accepting…' : 'Accept counter'}</Button><Button variant="outline" disabled={Boolean(acting)} onClick={() => void run('reject', () => onCounterResponse(false))}>{acting === 'reject' ? 'Rejecting…' : 'Reject counter'}</Button></>}<Button variant="outline" disabled={Boolean(acting)} onClick={() => void run('cancel', onCancel)}>{acting === 'cancel' ? 'Refunding…' : expired ? 'Reclaim escrow' : 'Cancel / refund'}</Button></div></div>{acting && <p className="offer-progress" role="status" aria-live="polite"><span className="offer-progress-spinner" aria-hidden="true" />{acting === 'accept' ? 'Accepting counter-offer…' : acting === 'reject' ? 'Rejecting counter-offer…' : 'Cancelling offer and refunding escrow…'}</p>}</div>
}


function ReferralPanel({ walletAddress }: { walletAddress: string }) {
  const [summary, setSummary] = useState<{ code: string; referrals: number; activated: number } | null>(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    void fetchReferralSummary(walletAddress).then((result) => { if (active) setSummary(result) }).catch(() => { if (active) setMessage('Invite link is temporarily unavailable.') })
    return () => { active = false }
  }, [walletAddress])

  const inviteUrl = summary ? `${window.location.origin}/?ref=${encodeURIComponent(summary.code)}` : ''
  const copy = async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setMessage('Invite link copied.')
      trackProductEvent('referral_link_copied')
    } catch { setMessage('Could not copy the link. Try sharing it from your browser.') }
  }
  const share = async () => {
    if (!inviteUrl || !navigator.share) return copy()
    try {
      await navigator.share({ title: 'Join me on StellaNova', text: 'Discover and share digital art on StellaNova.', url: inviteUrl })
      trackProductEvent('referral_link_shared')
      setMessage('Invite link shared.')
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      setMessage('Could not open sharing. Copy the link instead.')
    }
  }

  return <section className="section-block referral-panel"><div className="section-title"><div><span className="eyebrow">INVITE CREATORS & COLLECTORS</span><h3>Grow StellaNova together</h3></div></div><div className="referral-panel__card"><p>Invite someone to join. We count a referral as activated after their first confirmed Stellar mint or NFT collection.</p><div className="referral-panel__stats"><span><b>{summary?.referrals ?? '—'}</b><small>joined</small></span><span><b>{summary?.activated ?? '—'}</b><small>first on-chain action</small></span></div><div className="referral-panel__actions"><Button variant="outline" disabled={!summary} onClick={() => void copy()}><Icon name="copy" size={15} /> Copy invite link</Button><Button variant="primary" disabled={!summary} onClick={() => void share()}><Icon name="share" size={15} /> Share invite</Button></div>{message && <small className="referral-panel__message" role="status">{message}</small>}</div></section>
}

function AccountView({ allNfts, ownedNfts, allCollections, posts, account, stellarWallet, walletCollections, onCopyAddress, onCreateCollection, onCreateMint, marketplace, onCancelListing, onCancelOffer, onAcceptOffer, onRejectOffer, onCounterOffer, onCounterResponse, onOpen, saved, toggleSaved, liked, disliked, onLike, onDislike, onSell, onBulkList, onCollection, onCreator, subscriptions, onSubscribe, onSaveProfile, onDisconnectWallet }: { allNfts: NFT[]; ownedNfts: NFT[]; allCollections: Collection[]; posts: PostRecord[]; account: UserAccount | null; stellarWallet: StellarWallet | null; walletCollections: WalletCollection[]; onCopyAddress: (address: string) => void; onCreateCollection: () => void; onCreateMint: () => void; marketplace: MarketplaceState | null; onCancelListing: (listingId: number, contractId?: string) => void; onCancelOffer: (offerId: number, contractId?: string) => void; onAcceptOffer: (offerId: number, contractId?: string) => void; onRejectOffer: (offerId: number, contractId?: string) => void; onCounterOffer: (offerId: number, amount: string, contractId?: string) => Promise<boolean>; onCounterResponse: (offer: MarketplaceOffer, accept: boolean) => void; onOpen: (item: NFT) => void; saved: string[]; toggleSaved: (id: string) => void; liked: string[]; disliked: string[]; onLike: (id: string) => void; onDislike: (id: string) => void; onSell: (item: NFT) => void; onBulkList: (items: { item: NFT; price: string; paymentToken: string }[]) => Promise<void>; onCollection: (item: Collection) => void; onCreator: (id: string) => void; subscriptions: string[]; onSubscribe: (collection: Collection) => void; onSaveProfile: (profile: PublicProfileInput) => Promise<void>; onDisconnectWallet: () => void | Promise<void> }) {
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false)
  if (!stellarWallet) {
    return <div className="page"><section className="page-heading page-heading--compact"><div><span className="eyebrow">YOUR ACCOUNT</span><h1>Your gallery,<br /><i>your identity.</i></h1></div></section><div className="empty-state"><span className="empty-state__icon"><Icon name="wallet" size={24} /></span><h3>Connect to see your account.</h3><p>Connect a Stellar wallet to view your portfolio, collections and on-chain account.</p>  </div></div>
  }
  const name = account?.creator_username ? `@${account.creator_username}` : account?.display_name || shortenStellarAddress(stellarWallet.address)
  const role = account?.is_creator ? (account?.is_verified ? 'Verified creator' : 'Creator') : 'Collector'
  const mintedByWallet = allNfts.filter((item) => item.ownerAddress?.toLowerCase() === stellarWallet.address.toLowerCase())
  const uniqueTokens = new Map<string, NFT>()
  for (const item of [...ownedNfts, ...mintedByWallet]) {
    const key = item.contractId && item.tokenId !== undefined
      ? `${item.contractId.toLowerCase()}:${item.tokenId}`
      : item.id
    if (!uniqueTokens.has(key)) uniqueTokens.set(key, item)
  }
  const portfolioNfts = [...uniqueTokens.values()]
  const savedWorks = allNfts.filter((item) => saved.includes(item.id))
  const followedCollections = allCollections.filter((c) => subscriptions.includes(c.id))
  const verified = Boolean(account?.is_verified)
  return <div className="page page--account">
    <section className="account-hero">
      <div className="account-hero__avatar"><Avatar src={account?.avatar || ''} alt={name} size="lg" ring />{verified && <span className="account-hero__verified"><Verified /></span>}</div>
      <div className="account-hero__copy">
        <span className="eyebrow">YOUR ACCOUNT</span><h1>{name} {account?.is_verified ? <Verified /> : null}</h1>
        <p>{account?.bio || 'Collector & creator profiles are wallet-led — anyone with a Stellar wallet becomes a creator by creating a collection.'}</p>
        <div className="account-hero__addrs"><span className="account-wallet-address"><small>Wallet</small><span className="account-wallet-address__value"><b title={stellarWallet.address}>{shortenStellarAddress(stellarWallet.address)}</b><button type="button" className="account-wallet-copy" aria-label="Copy Stellar wallet address" title="Copy address" onClick={() => onCopyAddress(stellarWallet.address)}><Icon name="copy" size={15} /></button></span></span><span className="is-muted"><small>Wallet access</small><b>Signed session</b></span></div>
      </div>
      <div className="account-hero__actions"><Button variant="outline" onClick={() => setProfileSettingsOpen(true)}>Edit profile</Button>{stellarWallet.provider === 'Privy' && <Button variant="outline" onClick={onDisconnectWallet}>Sign out</Button>}<span className="profile-tag">{role}</span>{!account?.is_creator ? <Button onClick={onCreateCollection}><Icon name="plus" size={14} /> Create a collection</Button> : <Button variant="outline" onClick={onCreateCollection}><Icon name="plus" size={14} /> New collection</Button>}<Button variant="outline" onClick={onCreateMint}><Icon name="bookmark" size={14} /> Mint NFT</Button></div>
    </section>
    <div className="profile-stats account-stats"><span><b>{walletCollections.length}</b><small>collections</small></span><span><b>{savedWorks.length}</b><small>saved</small></span><span><b>{followedCollections.length}</b><small>following</small></span></div>
    <ReferralPanel walletAddress={stellarWallet.address} />
    <section className="section-block">
      <div className="section-title"><div><span className="eyebrow">YOUR NFTs</span><h3>{portfolioNfts.length ? 'Your owned NFTs' : 'No NFTs yet'}</h3></div><Button variant="quiet" onClick={onCreateMint}><Icon name="plus" size={15} /> Mint an NFT</Button></div>
      {portfolioNfts.length ? <div className="feed-grid feed-grid--account">{portfolioNfts.map((item) => {
        const offers = (marketplace?.incomingOffers ?? []).filter((offer) => offer.token_id === item.tokenId && offer.nft_contract.toLowerCase() === item.contractId?.toLowerCase())
        const bestOffer = offers.reduce((best, offer) => BigInt(offer.amount) > BigInt(best) ? offer.amount : best, '0')
        return <div className="account-nft-card" key={item.id}>
          <ArtworkCard item={item} collectionOverride={allCollections.find((collection) => collection.id === item.collectionId)} showReactions={false} offerReceived={offers.length ? { count: offers.length, bestAmount: bestOffer } : undefined} saved={saved.includes(item.id)} onSave={() => toggleSaved(item.id)} onOpen={() => onOpen(item)} onCreator={() => undefined} onCollection={() => onCollection(allCollections.find((collection) => collection.id === item.collectionId) ?? collectionFor(item.collectionId))} liked={liked.includes(item.id)} disliked={disliked.includes(item.id)} onLike={() => onLike(item.id)} onDislike={() => onDislike(item.id)} />
          <span className="account-current-owner"><Icon name="wallet" size={12} /> In your wallet</span>
        </div>
      })}</div> : <div className="empty-state empty-state--compact"><span className="empty-state__icon"><Icon name="bookmark" size={22} /></span><h3>Your NFT portfolio is empty.</h3><p>Personal NFTs and NFTs in collections you own will appear here.</p><Button onClick={onCreateMint}><Icon name="bookmark" size={14} /> Mint your first NFT</Button></div>}
    </section>
    <BulkListingPanel items={portfolioNfts} listings={marketplace?.listings ?? []} wallet={stellarWallet} onList={onBulkList} />
    <section className="section-block">
      <div className="section-title"><div><span className="eyebrow">YOUR COLLECTIONS</span><h3>{walletCollections.length ? 'Created & owned' : 'No collections yet'}</h3></div><Button variant="quiet" onClick={onCreateCollection}><Icon name="plus" size={15} /> {walletCollections.length ? 'New collection' : 'Create a collection'}</Button></div>
      {walletCollections.length ? <div className="collection-follow-row">{walletCollections.map((collection) => <button className="collection-follow-card" key={collection.id} aria-label={`Open ${collection.name} collection dashboard`} onClick={() => onCollection(allCollections.find((item) => item.id === collection.slug) ?? collectionFor(collection.slug))}><CollectionCover cover={collection.cover} name={collection.name} symbol={collection.symbol} className="collection-follow-card__cover" /><span><b>{collection.name} {collection.is_verified ? <Verified /> : null}</b><small>{collection.verification_status === 'approved' ? 'Verified collection' : collection.verification_status === 'pending' ? 'Verification pending' : `Symbol ${collection.symbol}`}</small></span><Icon name="chevron" size={16} /></button>)}</div> : <div className="empty-state empty-state--compact"><span className="empty-state__icon"><Icon name="bookmark" size={22} /></span><h3>Create your first collection.</h3><p>Creating a collection gives your profile creator status. Verification is a separate review.</p><Button onClick={onCreateCollection}><Icon name="plus" size={14} /> Create a collection</Button></div>}
    </section>
    {marketplace && (marketplace.listings.length > 0 || marketplace.offers.length > 0 || marketplace.incomingOffers.length > 0) && <section className="section-block"><div className="section-title"><div><span className="eyebrow">MARKETPLACE</span><h3>Manage your listings & offers</h3></div><Icon name="activity" size={18} /></div>{marketplace.listings.length > 0 && <div className="market-manage"><strong>Your live listings</strong>{marketplace.listings.map((listing) => <div className="management-row" key={`l-${listing.listing_id}`}><span><b>#{listing.listing_id}</b><small>Token #{listing.token_id} · {formatMarketplaceAmount(listing.price, listing.payment_token)}</small></span><Button variant="outline" onClick={() => onCancelListing(listing.listing_id, listing.contract_id)}>Cancel</Button></div>)}</div>}{marketplace.offers.length > 0 && <div className="market-manage"><strong>Offers you made</strong>{marketplace.offers.map((offer) => <MarketplaceOutgoingOfferRow key={`i-${offer.offer_id}`} offer={offer} onCancel={() => onCancelOffer(offer.offer_id, offer.contract_id)} onCounterResponse={(accept) => onCounterResponse(offer, accept)} />)}</div>}{marketplace.incomingOffers.length > 0 && <div className="market-manage"><strong>Offers on your NFTs</strong>{marketplace.incomingOffers.map((offer) => { const item = allNfts.find((nft) => nft.tokenId === offer.token_id && nft.contractId?.toLowerCase() === offer.nft_contract.toLowerCase()); return <MarketplaceIncomingOfferRow key={`incoming-${offer.offer_id}`} offer={offer} item={item} onOpen={item ? () => onOpen(item) : undefined} onAccept={() => onAcceptOffer(offer.offer_id, offer.contract_id)} onReject={() => onRejectOffer(offer.offer_id, offer.contract_id)} onCounter={(amount) => onCounterOffer(offer.offer_id, amount, offer.contract_id)} /> })}</div>}</section>}
    {savedWorks.length > 0 && <section className="section-block"><div className="section-title"><div><span className="eyebrow">YOUR PICKS</span><h3>Saved works</h3></div><span className="muted-note">{savedWorks.length} saved</span></div><div className="feed-grid feed-grid--account">{savedWorks.map((item) => <ArtworkCard item={item} collectionOverride={allCollections.find((collection) => collection.id === item.collectionId)} key={item.id} showReactions={false} saved onSave={() => toggleSaved(item.id)} onOpen={() => onOpen(item)} onCreator={() => undefined} onCollection={() => onCollection(allCollections.find((collection) => collection.id === item.collectionId) ?? collectionFor(item.collectionId))} liked={liked.includes(item.id)} disliked={disliked.includes(item.id)} onLike={() => onLike(item.id)} onDislike={() => onDislike(item.id)} />)}</div></section>}
    {profileSettingsOpen && <CreatorProfileSettingsModal account={account} ownedNfts={ownedNfts} posts={posts} walletCollections={walletCollections} walletAddress={stellarWallet.address} onSaveProfile={onSaveProfile} onClose={() => setProfileSettingsOpen(false)} />}
  </div>
}


function BulkListingPanel({ items, listings, wallet, onList }: { items: NFT[]; listings: MarketplaceListing[]; wallet: StellarWallet | null; onList: (items: { item: NFT; price: string; paymentToken: string }[]) => Promise<void> }) {
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [paymentToken, setPaymentToken] = useState(stellarPaymentAssets[0].contractId)
  const candidates = items.filter((item) => item.contractId && item.tokenId !== undefined && item.ownerAddress?.toLowerCase() === wallet?.address.toLowerCase() && !listings.some((listing) => listing.nft_contract.toLowerCase() === item.contractId!.toLowerCase() && listing.token_id === item.tokenId))
  const chosen = candidates.filter((item) => selected[item.id]).slice(0, 10)
  const submit = async () => {
    await onList(chosen.map((item) => ({ item, price: prices[item.id] || '1', paymentToken })))
    setSelected({})
  }
  if (!wallet || candidates.length === 0) return null
  return <section className="section-block bulk-listing-panel">
    <header className="bulk-listing-panel__header">
      <div><span className="eyebrow">BULK LISTING</span><h3>List several NFTs</h3><p>Select up to ten NFTs and set each price. They’ll be listed together in one transaction.</p></div>
      <Button onClick={() => void submit()} disabled={!chosen.length}>{chosen.length ? `List ${chosen.length} NFT${chosen.length === 1 ? '' : 's'}` : 'Select NFTs'}</Button>
    </header>
    {stellarPaymentAssets.length > 1 && <label className="bulk-listing-panel__currency"><span>Payment currency</span><select value={paymentToken} onChange={(event) => setPaymentToken(event.target.value)}>{stellarPaymentAssets.map((asset) => <option key={asset.contractId} value={asset.contractId}>{asset.code}</option>)}</select></label>}
    <div className="bulk-listing-panel__items" role="list">
      {candidates.map((item) => <div className="bulk-listing-panel__row" key={item.id} role="listitem">
        <input type="checkbox" aria-label={`Select ${item.title} for bulk listing`} checked={Boolean(selected[item.id])} disabled={!selected[item.id] && chosen.length >= 10} onChange={(event) => setSelected((current) => ({ ...current, [item.id]: event.target.checked }))} />
        <span className="bulk-listing-panel__asset"><b title={item.title}>{item.title}</b><small>Token #{item.tokenId}</small></span>
        <label className="bulk-listing-panel__price"><span>Listing price</span><span className="bulk-listing-panel__price-input"><input aria-label={`Listing price for ${item.title}`} type="number" min="0.0000001" step="any" value={prices[item.id] ?? '1'} onChange={(event) => setPrices((current) => ({ ...current, [item.id]: event.target.value }))} /><b>{stellarPaymentAssets.find((asset) => asset.contractId === paymentToken)?.code ?? 'token'}</b></span></label>
      </div>)}
    </div>
  </section>
}
function ArtworkCard({ item, collectionOverride, saved, onSave, onOpen, onCreator, onCollection, onSell, liked, disliked, onLike, onDislike, showReactions = true, offerReceived, editionCount = 1, feedHeader, onCommentToggle, commentCount, feedComments, showShare = false }: { item: NFT; collectionOverride?: Collection; saved: boolean; onSave: () => void; onOpen: () => void; onCreator: () => void; onCollection?: () => void; onSell?: () => void; liked?: boolean; disliked?: boolean; onLike?: () => void; onDislike?: () => void; showReactions?: boolean; offerReceived?: { count: number; bestAmount: string }; editionCount?: number; feedHeader?: { name: string; avatar: string; date: string }; onCommentToggle?: () => void; commentCount?: number; feedComments?: ReactNode; showShare?: boolean }) {
  const creatorProfiles = useContext(CreatorProfilesContext)
  const marketActions = useContext(NftCardActionsContext)
  const collection = collectionOverride ?? collectionFor(item.collectionId)
  const isOwner = Boolean(marketActions.walletAddress && item.ownerAddress?.toLowerCase() === marketActions.walletAddress.toLowerCase())
  const activeListing = item.contractId && item.tokenId !== undefined
    ? marketActions.activeListings.find((listing) => listing.nft_contract.toLowerCase() === item.contractId!.toLowerCase() && listing.token_id === item.tokenId)
    : undefined
  const activeAuction = item.contractId && item.tokenId !== undefined
    ? marketActions.activeAuctions.find((auction) => auction.nft_contract.toLowerCase() === item.contractId!.toLowerCase() && auction.token_id === item.tokenId)
    : undefined
  const incomingOffers = isOwner && item.contractId && item.tokenId !== undefined
    ? (marketActions.marketplace?.incomingOffers ?? []).filter((offer) => offer.token_id === item.tokenId && offer.nft_contract.toLowerCase() === item.contractId!.toLowerCase())
    : []
  const topIncomingOffer = incomingOffers.reduce<MarketplaceOffer | null>((best, offer) => !best || BigInt(offer.amount) > BigInt(best.amount) ? offer : best, null)
  const creator = creatorFor(item.ownerAddress || item.creatorId, creatorProfiles)
  const displayTitle = displayNftTitle(item.title)
  const ownerName = item.tokenId !== undefined && !item.ownerAddress ? 'Owner updating' : creator.name === 'Stellar creator' ? shortenStellarAddress(item.ownerAddress || item.creatorId) : creator.name
  const isStandalone = collection.name === 'Standalone NFT' || item.collectionId === 'standalone-nft'
  return <article className={`art-card${feedHeader ? ' art-card--feed' : ''}`}>
    {feedHeader && <header className="art-card__feed-head"><Avatar src={feedHeader.avatar} alt={feedHeader.name} size="sm" /><span><b>{feedHeader.name}</b><small>shared a collectible</small></span><time>{feedHeader.date}</time></header>}
    <button className="art-card__image" onClick={onOpen}>{item.image ? <img src={item.image} alt={displayTitle} /> : <span className="artwork-unavailable">Artwork unavailable</span>}{editionCount > 1 && <span className="edition-count-badge">{editionCount} owned</span>}{item.trend && <span className="trend-badge">{item.trend}</span>}{(offerReceived || topIncomingOffer) && <span className="account-offer-badge"><Icon name="activity" size={13} /> OFFER / {formatOfferXlm(topIncomingOffer?.amount ?? offerReceived!.bestAmount)} XLM{incomingOffers.length > 1 ? ` / ${incomingOffers.length}` : offerReceived && offerReceived.count > 1 ? ` / ${offerReceived.count}` : ''}</span>}<span className="sale-badge">{item.saleType}</span></button>
    <div className="art-card__body"><div className="art-card__title"><div>{!isStandalone && displayTitle.toLocaleLowerCase() !== collection.name.trim().toLocaleLowerCase() && <button className="collection-link" onClick={onCollection}>{collection.name}</button>}<h4>{displayTitle}</h4><span className="creator-link"><Avatar src={creator.avatar} alt={ownerName} size="xs" />Owned by {ownerName}<span className="verified-dot">{creator.verified ? '✓' : ''}</span></span></div><div className="art-card__social">{showReactions && <><button className={`save-button save-button--card ${liked ? 'is-active-up' : ''}`} onClick={onLike} aria-label={`Thumbs up ${displayTitle}`} title="Thumbs up"><Icon name="thumbUp" size={16} /><small>{item.likes}</small></button><button className={`save-button save-button--card ${disliked ? 'is-active-down' : ''}`} onClick={onDislike} aria-label={`Thumbs down ${displayTitle}`} title="Thumbs down"><Icon name="thumbDown" size={16} /></button><button className="save-button save-button--card" onClick={onCommentToggle ?? onOpen} aria-label={`Comments for ${displayTitle}`} title="Comments"><Icon name="comment" size={16} /><small>{commentCount ?? item.comments}</small></button></>}<button className={`save-button save-button--card ${saved ? 'is-saved' : ''}`} onClick={onSave} aria-label={saved ? 'Remove saved collectible' : 'Save collectible'}><Icon name="bookmark" size={17} /></button>{showShare && <ShareNftButton item={item} />}</div></div><div className="art-card__price"><span><small>{item.saleType === 'Auction' ? item.auctionEnds : item.saleType === 'Offers' ? 'Best offer' : item.saleType === 'Not listed' ? 'Sale status' : 'Current price'}</small><b>{item.saleType === 'Offers' ? item.bestOffer : item.price}</b></span><div className="art-card__actions"><Button variant="outline" onClick={onOpen}>View</Button>{isOwner ? <>{activeAuction ? <>{marketActions.latestLedger >= activeAuction.ends_at && <Button onClick={() => marketActions.settleAuction(activeAuction.auction_id)}>Settle auction</Button>}{marketActions.latestLedger < activeAuction.ends_at && !activeAuction.highest_bidder && <Button variant="quiet" onClick={() => marketActions.cancelAuction(activeAuction.auction_id)}>Cancel auction</Button>}</> : activeListing && activeListing.seller.toLowerCase() === marketActions.walletAddress.toLowerCase() ? <><Button variant="outline" onClick={() => marketActions.sell(item)}>Edit listing</Button><Button variant="quiet" onClick={() => marketActions.cancelListing(activeListing.listing_id, activeListing.contract_id)}>Cancel listing</Button></> : <><Button variant="quiet" onClick={onSell ?? (() => marketActions.sell(item))}>List</Button><Button variant="quiet" onClick={() => marketActions.auction(item)}>Start auction</Button></>}{topIncomingOffer && <Button onClick={() => marketActions.acceptOffer(topIncomingOffer.offer_id, topIncomingOffer.contract_id)}>Accept offer · {formatOfferXlm(topIncomingOffer.amount)} XLM</Button>}</> : <>{item.saleType === 'Auction' && activeAuction && marketActions.latestLedger >= activeAuction.ends_at ? <Button onClick={() => marketActions.settleAuction(activeAuction.auction_id)}>Settle auction</Button> : <>{item.saleType !== 'Auction' && item.tokenId !== undefined && item.contractId && <Button variant="quiet" onClick={() => marketActions.offer(item)}>Make offer</Button>}{item.saleType === 'Buy now' && <Button onClick={() => marketActions.buy(item)}>Buy · {item.price}</Button>}{item.saleType === 'Auction' && <Button onClick={() => marketActions.bid(item)}>Place bid</Button>}</>}</>}</div></div></div>
    {feedComments}
  </article>
}

function NftArtwork({ item }: { item: NFT }) {
  const media = item.animation_url ?? ''
  const path = media.split('?')[0].toLowerCase()
  const isModel = /\.(glb|gltf)$/.test(path)
  const [modelReady, setModelReady] = useState(() => typeof customElements !== 'undefined' && Boolean(customElements.get('model-viewer')))
  const [modelFailed, setModelFailed] = useState(false)
  useEffect(() => {
    if (!isModel || modelReady) return
    let active = true
    import('@google/model-viewer').then(() => { if (active) setModelReady(true) }).catch(() => { if (active) setModelFailed(true) })
    return () => { active = false }
  }, [isModel, modelReady])
  if (/\.(mp4|webm|mov)$/.test(path)) return <video src={media} poster={item.image} controls playsInline />
  if (/\.(mp3|wav|ogg|m4a|aac)$/.test(path)) return <div className="nft-audio"><img src={item.image} alt={item.title} /><audio src={media} controls /></div>
  if (isModel && modelReady) return createElement('model-viewer' as any, { className: 'nft-model-viewer', src: media, alt: item.title, 'camera-controls': true, 'auto-rotate': true, 'shadow-intensity': '1', 'interaction-prompt': 'auto' })
  if (isModel) return <div className="nft-model-loading"><img src={item.image} alt={item.title} /><small>{modelFailed ? 'Interactive 3D preview failed to load.' : 'Loading interactive 3D preview…'}</small>{modelFailed && <a href={media} target="_blank" rel="noreferrer">Open model file</a>}</div>
  return item.image ? <img src={item.image} alt={item.title} /> : <span className="artwork-unavailable">Artwork unavailable</span>
}

function CollectionOffersPanel({ collection, items, wallet, owner, notify }: { collection: Collection; items: NFT[]; wallet: StellarWallet | null; owner: boolean; notify: (message: string) => void }) {
  const [offers, setOffers] = useState<MarketplaceCollectionOffer[]>([])
  const [traitOffers, setTraitOffers] = useState<MarketplaceTraitOffer[]>([])
  const [amount, setAmount] = useState('1')
  const [paymentToken, setPaymentToken] = useState(sorobanMarketplaceConfig.paymentToken ?? stellarPaymentAssets[0].contractId)
  const [tokenId, setTokenId] = useState('')
  const traitTypes = [...new Set(items.flatMap((item) => item.attributes?.map((trait) => trait.trait_type) ?? []))].sort()
  const [traitType, setTraitType] = useState('')
  const traitValues = [...new Set(items.flatMap((item) => item.attributes?.filter((trait) => !traitType || trait.trait_type === traitType).map((trait) => String(trait.value)) ?? []))].sort()
  const [traitValue, setTraitValue] = useState('')
  const [registrationOffset, setRegistrationOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(() => {
    void Promise.all([fetchActiveMarketplaceCollectionOffers(), fetchActiveMarketplaceTraitOffers()]).then(([rows, traits]) => {
      setOffers(rows.filter((row) => row.nft_contract.toLowerCase() === collection.contractId?.toLowerCase() && row.collection_scope === collection.id))
      setTraitOffers(traits.filter((row) => row.nft_contract.toLowerCase() === collection.contractId?.toLowerCase() && row.collection_scope === collection.id))
      setError('')
    }).catch((cause) => setError(cause instanceof TypeError || (cause instanceof Error && /failed to fetch|networkerror/i.test(cause.message))
      ? 'Collection offers could not load. Check your connection and try again.'
      : cause instanceof Error ? cause.message : 'Collection offers are temporarily unavailable'))
  }, [collection.contractId, collection.id])
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 20_000); return () => window.clearInterval(timer) }, [refresh])
  const mine = offers.filter((offer) => offer.buyer.toLowerCase() === wallet?.address.toLowerCase())
  const eligible = items.filter((item) => item.contractId?.toLowerCase() === collection.contractId?.toLowerCase() && item.tokenId !== undefined && item.ownerAddress?.toLowerCase() === wallet?.address.toLowerCase())
  const traitRegistrationItems = items.filter((item) => item.contractId?.toLowerCase() === collection.contractId?.toLowerCase() && item.tokenId !== undefined && (item.attributes?.length ?? 0) > 0)
  const createOffer = async () => {
    if (!wallet || !collection.contractId || !sorobanMarketplaceConfig.marketplaceContractId) { setError('Connect a wallet and use a collection with a deployed Stellar contract'); return }
    const asset = stellarPaymentAssets.find((entry) => entry.contractId === paymentToken) ?? stellarPaymentAssets[0]
    try {
      setBusy(true); setError('')
      const units = assetAmountToUnits(amount, asset.decimals)
      if (units <= 0n) throw new Error(`Enter an offer greater than 0 ${asset.code}`)
      await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'make_collection_offer', [
        StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
        StellarSdk.nativeToScVal(collection.contractId, { type: 'address' }),
        StellarSdk.nativeToScVal(collection.id, { type: 'string' }),
        StellarSdk.nativeToScVal(paymentToken, { type: 'address' }),
        StellarSdk.nativeToScVal(units, { type: 'i128' }),
      ], wallet)
      notify(`Collection offer submitted for ${collection.name}`); refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not submit collection offer') }
    finally { setBusy(false) }
  }
  const settleOffer = async (offer: MarketplaceCollectionOffer, accept: boolean) => {
    if (!wallet || !sorobanMarketplaceConfig.marketplaceContractId) return
    try {
      setBusy(true); setError('')
      await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, accept ? 'accept_collection_offer' : offer.buyer.toLowerCase() === wallet.address.toLowerCase() ? 'cancel_collection_offer' : 'expire_collection_offer', accept ? [
        StellarSdk.nativeToScVal(offer.offer_id, { type: 'u32' }), StellarSdk.nativeToScVal(wallet.address, { type: 'address' }), StellarSdk.nativeToScVal(Number(tokenId), { type: 'u32' }),
      ] : [StellarSdk.nativeToScVal(offer.offer_id, { type: 'u32' })], wallet)
      notify(accept ? 'Collection offer accepted; NFT transferred on Stellar' : 'Collection offer cancelled and escrow refunded'); refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not process collection offer') }
    finally { setBusy(false) }
  }
  const createTraitOffer = async () => {
    if (!wallet || !collection.contractId || !sorobanMarketplaceConfig.marketplaceContractId) { setError('Connect a wallet and use a collection with a deployed Stellar contract'); return }
    const asset = stellarPaymentAssets.find((entry) => entry.contractId === paymentToken) ?? stellarPaymentAssets[0]
    try {
      setBusy(true); setError('')
      const units = assetAmountToUnits(amount, asset.decimals)
      if (!traitType || !traitValue) throw new Error('Choose a trait category and value')
      if (units <= 0n) throw new Error(`Enter an offer greater than 0 ${asset.code}`)
      await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'make_trait_offer', [
        StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
        StellarSdk.nativeToScVal(collection.contractId, { type: 'address' }),
        StellarSdk.nativeToScVal(collection.id, { type: 'string' }),
        StellarSdk.nativeToScVal(traitType, { type: 'string' }),
        StellarSdk.nativeToScVal(traitValue, { type: 'string' }),
        StellarSdk.nativeToScVal(paymentToken, { type: 'address' }),
        StellarSdk.nativeToScVal(units, { type: 'i128' }),
      ], wallet)
      notify(`Trait offer submitted for ${traitType}: ${traitValue}`); refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not submit trait offer') }
    finally { setBusy(false) }
  }
  const settleTraitOffer = async (offer: MarketplaceTraitOffer, accept: boolean) => {
    if (!wallet || !sorobanMarketplaceConfig.marketplaceContractId) return
    try {
      setBusy(true); setError('')
      await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, accept ? 'accept_trait_offer' : offer.buyer.toLowerCase() === wallet.address.toLowerCase() ? 'cancel_trait_offer' : 'expire_trait_offer', accept ? [
        StellarSdk.nativeToScVal(offer.offer_id, { type: 'u32' }), StellarSdk.nativeToScVal(wallet.address, { type: 'address' }), StellarSdk.nativeToScVal(Number(tokenId), { type: 'u32' }),
      ] : [StellarSdk.nativeToScVal(offer.offer_id, { type: 'u32' })], wallet)
      notify(accept ? `Trait offer accepted; ${traitType} NFT transferred` : 'Trait offer cancelled and escrow refunded'); refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not process trait offer') }
    finally { setBusy(false) }
  }
  const registerNextTraits = async () => {
    if (!wallet || !collection.contractId) return
    const batch = traitRegistrationItems.slice(registrationOffset, registrationOffset + 10)
    if (!batch.length) { setRegistrationOffset(0); return }
    setBusy(true); setError('')
    try {
      const calls = batch.map((item) => {
        const attributes = item.attributes ?? []
        return { method: 'set_token_traits', args: [StellarSdk.nativeToScVal(wallet.address, { type: 'address' }), StellarSdk.nativeToScVal(item.tokenId, { type: 'u32' }), StellarSdk.nativeToScVal(attributes.map((trait) => trait.trait_type)), StellarSdk.nativeToScVal(attributes.map((trait) => String(trait.value)))] }
      })
      await invokeSorobanBatch(collection.contractId, calls, wallet)
      const nextOffset = registrationOffset + batch.length
      setRegistrationOffset(nextOffset >= traitRegistrationItems.length ? 0 : nextOffset)
      notify(`Committed on-chain traits for ${batch.length} NFT${batch.length === 1 ? '' : 's'}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not commit NFT traits on-chain') }
    finally { setBusy(false) }
  }
  if (!collection.contractId || !sorobanMarketplaceConfig.marketplaceContractId) return null
  return <section id="collection-offers" className="section-block collection-offers-panel collection-page-panel"><div className="section-title"><div><span className="eyebrow">COLLECTION & TRAIT OFFERS</span><h3>Offers across this collection</h3></div></div>{owner && traitRegistrationItems.length > 0 && <div className="collection-offers-panel__accept"><p>Trait offers match immutable on-chain traits. Commit the NFT metadata traits before sellers can accept a trait offer.</p><Button variant="outline" onClick={() => void registerNextTraits()} disabled={busy}>Commit traits on-chain ({Math.min(10, Math.max(0, traitRegistrationItems.length - registrationOffset))} next)</Button></div>}{wallet ? <><div className="collection-offers-panel__create"><label>Collection offer<input type="number" min="0.0000001" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><label>Currency<select value={paymentToken} onChange={(event) => setPaymentToken(event.target.value)}>{stellarPaymentAssets.map((asset) => <option key={asset.contractId} value={asset.contractId}>{asset.code}</option>)}</select></label><Button onClick={() => void createOffer()} disabled={busy}>Make collection offer</Button></div>{traitTypes.length > 0 && <div className="collection-offers-panel__create"><label>Trait category<select value={traitType} onChange={(event) => { setTraitType(event.target.value); setTraitValue('') }}><option value="">Choose trait</option>{traitTypes.map((name) => <option key={name}>{name}</option>)}</select></label><label>Trait value<select value={traitValue} onChange={(event) => setTraitValue(event.target.value)}><option value="">Choose value</option>{traitValues.map((value) => <option key={value}>{value}</option>)}</select></label><label>Offer amount ({stellarPaymentAssets.find((asset) => asset.contractId === paymentToken)?.code ?? 'XLM'})<input type="number" min="0.0000001" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><Button onClick={() => void createTraitOffer()} disabled={busy || !traitType || !traitValue}>Make trait offer</Button></div>}</> : <p>Connect a Stellar wallet to make an offer.</p>}{eligible.length > 0 && <div className="collection-offers-panel__accept"><label>Your NFT<select value={tokenId} onChange={(event) => setTokenId(event.target.value)}><option value="">Choose a token</option>{eligible.map((item) => <option key={item.tokenId} value={item.tokenId}>#{item.tokenId} · {item.title}</option>)}</select></label></div>}{error && <div role="alert" className="offer-progress offer-progress--error"><span>{error}</span><Button variant="outline" onClick={refresh}>Retry</Button></div>}{!error && offers.length === 0 && traitOffers.length === 0 && <p className="muted-note">No active collection or trait offers.</p>}{offers.length > 0 && <div className="market-manage"><strong>Collection offers</strong>{offers.map((offer) => { const asset = stellarPaymentAssets.find((entry) => entry.contractId === offer.payment_token); const expired = offer.expires_at * 1000 <= Date.now(); const ownerCanAccept = eligible.length > 0 && !expired && offer.buyer.toLowerCase() !== wallet?.address.toLowerCase(); const buyerCanCancel = offer.buyer.toLowerCase() === wallet?.address.toLowerCase(); return <article className="market-manage__row" key={`c:${offer.contract_id}:${offer.offer_id}`}><div><b>{formatTokenAmount(offer.amount, asset?.decimals ?? 7)} {asset?.code ?? 'token'}</b><small>{shortenStellarAddress(offer.buyer)} · expires {new Date(offer.expires_at * 1000).toLocaleString()}</small></div>{ownerCanAccept && <Button onClick={() => void settleOffer(offer, true)} disabled={busy || !tokenId}>Accept</Button>}{buyerCanCancel && <Button variant="outline" onClick={() => void settleOffer(offer, false)} disabled={busy}>Cancel</Button>}{expired && wallet && !buyerCanCancel && <Button variant="outline" onClick={() => void settleOffer(offer, false)} disabled={busy}>Reclaim expired offer</Button>}</article> })}</div>}{traitOffers.length > 0 && <div className="market-manage"><strong>Trait offers</strong>{traitOffers.map((offer) => { const asset = stellarPaymentAssets.find((entry) => entry.contractId === offer.payment_token); const matching = eligible.find((item) => String(item.tokenId) === tokenId)?.attributes?.some((trait) => trait.trait_type === offer.trait_type && String(trait.value) === offer.trait_value); const expired = offer.expires_at * 1000 <= Date.now(); const ownerCanAccept = Boolean(matching) && !expired && offer.buyer.toLowerCase() !== wallet?.address.toLowerCase(); const buyerCanCancel = offer.buyer.toLowerCase() === wallet?.address.toLowerCase(); return <article className="market-manage__row" key={`t:${offer.contract_id}:${offer.offer_id}`}><div><b>{offer.trait_type}: {offer.trait_value} · {formatTokenAmount(offer.amount, asset?.decimals ?? 7)} {asset?.code ?? 'token'}</b><small>{shortenStellarAddress(offer.buyer)} · expires {new Date(offer.expires_at * 1000).toLocaleString()}</small></div>{ownerCanAccept && <Button onClick={() => void settleTraitOffer(offer, true)} disabled={busy || !tokenId}>Accept</Button>}{buyerCanCancel && <Button variant="outline" onClick={() => void settleTraitOffer(offer, false)} disabled={busy}>Cancel</Button>}{expired && wallet && !buyerCanCancel && <Button variant="outline" onClick={() => void settleTraitOffer(offer, false)} disabled={busy}>Reclaim expired offer</Button>}</article> })}</div>}</section>
}

function CreatorRoyaltySettings({ collection, wallet, notify }: { collection: Collection; wallet: StellarWallet | null; notify: (message: string) => void }) {
  const [bps, setBps] = useState('0')
  const [recipient, setRecipient] = useState(wallet?.address ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [creatorCheck, setCreatorCheck] = useState<'checking' | 'supported' | 'legacy' | 'unsupported' | 'not-owner' | 'unavailable'>('checking')
  useEffect(() => { if (wallet?.address && !recipient) setRecipient(wallet.address) }, [wallet?.address, recipient])
  useEffect(() => {
    let active = true
    if (!wallet || !collection.contractId) { setCreatorCheck('unavailable'); return }
    setCreatorCheck('checking')
    void simulateSorobanRead(collection.contractId, 'collection_owner', [StellarSdk.nativeToScVal(collection.id, { type: 'string' })], wallet)
      .then((owner) => { if (active) setCreatorCheck(typeof owner === 'string' && owner.toLowerCase() === wallet.address.toLowerCase() ? 'supported' : 'not-owner') })
      .catch((cause) => {
        if (!active) return
        const errorText = cause instanceof Error ? cause.message : String(cause)
        setCreatorCheck(/non-existent contract function|unknown function|collection_owner/i.test(errorText) ? 'legacy' : 'unavailable')
      })
    return () => { active = false }
  }, [collection.contractId, collection.id, wallet?.address, wallet?.networkPassphrase])
  if (!collection.contractId || !wallet) return null
  const save = async () => {
    if (!['supported', 'legacy'].includes(creatorCheck)) return setMessage(creatorCheck === 'checking' ? 'Checking the collection creator on Stellar; try again in a moment.' : 'This wallet is not registered as the creator of this collection. No transaction was sent.')
    const percentBps = Number(bps)
    if (!Number.isInteger(percentBps) || percentBps < 0 || percentBps > 1000) return setMessage('Choose a royalty from 0% to 10% (basis points, 0–1000).')
    if (!/^G[A-Z2-7]{55}$/.test(recipient)) return setMessage('Enter a valid Stellar wallet address for royalty payments.')
    if (!sorobanMarketplaceConfig.marketplaceContractId) return setMessage('The marketplace contract is not configured.')
    setBusy(true); setMessage('')
    try {
      if (creatorCheck === 'legacy') {
        const registration = await fetch(`/api/collections/${encodeURIComponent(collection.id)}/royalty-registry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(wallet.address) },
          body: JSON.stringify({}),
        })
        const registrationBody = await registration.json().catch(() => ({})) as { error?: string }
        if (!registration.ok) throw new Error(registrationBody.error ?? 'Could not verify and register this collection for royalties.')
      }
      await invokeSoroban(sorobanMarketplaceConfig.marketplaceContractId, 'set_creator_royalty', [
        StellarSdk.nativeToScVal(collection.contractId, { type: 'address' }),
        StellarSdk.nativeToScVal(collection.id, { type: 'string' }),
        StellarSdk.nativeToScVal(wallet.address, { type: 'address' }),
        StellarSdk.nativeToScVal(recipient, { type: 'address' }),
        StellarSdk.nativeToScVal(percentBps, { type: 'u32' }),
      ], wallet)
      const success = `Creator royalty set to ${(percentBps / 100).toFixed(2)}% on marketplace sales.`
      setMessage(success); notify(success)
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not save creator royalty') }
    finally { setBusy(false) }
  }
  return <section className="section-block creator-royalty-settings"><div className="section-title"><div><span className="eyebrow">CREATOR ROYALTY</span><h3>Set your secondary-sale royalty</h3></div></div><p>Paid to your chosen wallet when a sale or accepted offer closes through the StellaNova marketplace. Maximum 10%.</p>{creatorCheck === 'checking' && <p role="status">Checking collection creator support…</p>}{creatorCheck === 'legacy' && <p role="status">This older NFT contract has no creator lookup. StellaNova will verify the collection owner from its saved creator record and register its minted tokens on the marketplace before saving.</p>}{creatorCheck === 'not-owner' && <p role="status">The connected wallet is not registered as this collection’s creator.</p>}{['supported', 'legacy'].includes(creatorCheck) && <div className="collection-offers-panel__create"><label>Basis points (100 = 1%)<input type="number" min="0" max="1000" step="1" value={bps} onChange={(event) => setBps(event.target.value)} /></label><label>Recipient wallet<input value={recipient} onChange={(event) => setRecipient(event.target.value)} /></label><Button onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save royalty'}</Button></div>}{creatorCheck === 'unavailable' && <p role="status">Could not verify this collection creator on Stellar. Retry after the Testnet RPC is available.</p>}{message && <p role="status">{message}</p>}</section>
}

function DetailView({ detail, allNfts, allCollections, posts, saved, toggleSaved, openNft, onBack, onCreator, onCollection, onBuy, onOffer, comments, onComment, liked, disliked, onLike, onDislike, onSell, creatorFollows, onFollowCreator, subscribedCollections, onFollowCollection, stellarWallet, walletCollections, marketplace, onAcceptOffer, onRejectOffer, onCounterOffer, notify, setMintedNfts, onStageMintsConfirmed, onCreateCollectionPost, onCreateCollectionStory, onPostLike, onPostComment, onPostDislike, onCollectionUpdated }: { detail: Detail; allNfts: NFT[]; allCollections: Collection[]; posts: PostRecord[]; saved: string[]; toggleSaved: (id: string) => void; openNft: (item: NFT) => void; onBack: () => void; onCreator: (id: string) => void; onCollection: (item: Collection) => void; onBuy: (item: NFT) => void; onOffer: (item: NFT) => void; comments: Record<string, SocialComment[]>; onComment: (id: string, text: string, parentId?: number | string | null) => Promise<void>; liked: string[]; disliked: string[]; onLike: (id: string) => void; onDislike: (id: string) => void; onSell: (item: NFT) => void; creatorFollows: string[]; onFollowCreator: (id: string) => void; subscribedCollections: string[]; onFollowCollection: (collection: Collection) => void; stellarWallet: StellarWallet | null; walletCollections: WalletCollection[]; marketplace: MarketplaceState | null; onAcceptOffer: (offerId: number, contractId?: string) => void; onRejectOffer: (offerId: number, contractId?: string) => void; onCounterOffer: (offerId: number, amount: string, contractId?: string) => Promise<boolean | void> | boolean | void; notify: (message: string) => void; setMintedNfts: (items: MintedNft[]) => void; onStageMintsConfirmed: (inputs: MintRecordInput[]) => void; onCreateCollectionPost: (collection: Collection, caption: string, mediaUrl: string) => Promise<void>; onCreateCollectionStory: (collection: Collection, caption: string, mediaUrl: string) => Promise<void>; onPostLike: (id: number) => void; onPostComment: (id: number, text: string, parentId?: number | string | null) => Promise<void>; onPostDislike: (id: number) => void; onCollectionUpdated: (id: string, changes: Partial<Collection>) => void }) {
  const creatorProfiles = useContext(CreatorProfilesContext)
  const [collectionSearch, setCollectionSearch] = useState('')
  const [collectionSort, setCollectionSort] = useState('newest')
  const [collectionPosts, setCollectionPosts] = useState<PostRecord[]>([])
  const [collectionPostsLoading, setCollectionPostsLoading] = useState(false)
  const [publicCreatorProfile, setPublicCreatorProfile] = useState<PublicCreatorProfile | null>(null)
  const [publicCreatorPosts, setPublicCreatorPosts] = useState<PostRecord[]>([])
  const [publicCreatorLoading, setPublicCreatorLoading] = useState(false)
  const [publicCreatorError, setPublicCreatorError] = useState('')
  const [detailMarketplace, setDetailMarketplace] = useState<MarketplaceState | null>(null)
  useEffect(() => {
    if (detail.type !== 'creator') { setPublicCreatorProfile(null); setPublicCreatorPosts([]); setPublicCreatorError(''); return }
    let active = true
    setPublicCreatorProfile(null)
    setPublicCreatorPosts([])
    setPublicCreatorLoading(true)
    setPublicCreatorError('')
    void fetchPublicCreatorProfile(detail.id).then(async (profile) => {
      if (!active) return
      setPublicCreatorProfile(profile)
      const creatorPosts = await fetchPosts(stellarWallet?.address, undefined, undefined, profile.wallet_address).catch(() => [])
      if (active) setPublicCreatorPosts(creatorPosts)
    }).catch((error) => {
      if (active) setPublicCreatorError(error instanceof Error ? error.message : 'This public profile could not be loaded.')
    }).finally(() => { if (active) setPublicCreatorLoading(false) })
    return () => { active = false }
  }, [detail.type === 'creator' ? detail.id : '', stellarWallet?.address])
  useEffect(() => {
    if (detail.type !== 'nft' || !stellarWallet) { setDetailMarketplace(null); return }
    let active = true
    const refresh = () => void fetchMarketplaceState(stellarWallet.address).then((state) => { if (active) setDetailMarketplace(state) }).catch(() => {})
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [detail.type === 'nft' ? detail.item.id : '', stellarWallet?.address])
  useEffect(() => {
    if (detail.type !== 'collection') return
    let active = true
    setCollectionPostsLoading(true)
    void fetchPosts(undefined, detail.item.id).then((items) => { if (active) setCollectionPosts(items) }).catch(() => { if (active) setCollectionPosts([]) }).finally(() => { if (active) setCollectionPostsLoading(false) })
    return () => { active = false }
  }, [detail.type === 'collection' ? detail.item.id : ''])
  useEffect(() => {
    if (detail.type !== 'collection') return
    const refreshCollection = (event: Event) => {
      const collectionId = (event as CustomEvent<{ collectionId?: string }>).detail?.collectionId
      if (collectionId !== detail.item.id) return
      void fetchPosts(undefined, detail.item.id).then(setCollectionPosts).catch(() => {})
    }
    window.addEventListener('nftgram:refresh-collection', refreshCollection)
    return () => window.removeEventListener('nftgram:refresh-collection', refreshCollection)
  }, [detail.type === 'collection' ? detail.item.id : ''])
  if (detail.type === 'nft') {
    const item = detail.item
    const offerState = detailMarketplace ?? marketplace
    const matchingOffers = item.contractId && item.tokenId !== undefined ? (offerState?.incomingOffers ?? []).filter((offer) => offer.nft_contract.toLowerCase() === item.contractId!.toLowerCase() && offer.token_id === item.tokenId) : []
    const isCurrentOwner = Boolean(stellarWallet?.address && item.ownerAddress?.toLowerCase() === stellarWallet.address.toLowerCase())
    const creator = creatorFor(item.ownerAddress || item.creatorId, creatorProfiles)
    const artist = creatorFor(item.creatorId, creatorProfiles)
    const ownerName = item.tokenId !== undefined && !item.ownerAddress ? 'Owner updating' : creator.name === 'Stellar creator' ? shortenStellarAddress(item.ownerAddress || item.creatorId) : creator.name
    const collection = collectionFor(item.collectionId)
    const currentOwner = (item.ownerAddress || item.creatorId).toLowerCase()
    const relatedNfts = allNfts.filter((next) => next.id !== item.id && (next.ownerAddress || next.creatorId).toLowerCase() === currentOwner).slice(0, 3)
    return <div className="detail-page"><button className="back-link" onClick={onBack}><Icon name="arrow" size={16} /> Back to feed</button><div className="detail-grid"><div className="detail-art"><NftArtwork item={item} /></div><div className="detail-copy"><div className="detail-kicker"><span className="eyebrow">{collection.symbol} · {item.trait}</span><CopyLinkButton path={`/nft/${encodeURIComponent(item.id)}`} label="Share NFT" /><button className={`save-button ${saved.includes(item.id) ? 'is-saved' : ''}`} onClick={() => toggleSaved(item.id)}><Icon name="bookmark" size={20} /></button></div><h1>{displayNftTitle(item.title)}</h1><button className="detail-creator" onClick={() => onCreator(creator.id)}><Avatar src={creator.avatar} alt={ownerName} size="sm" ring /><span><b>{ownerName} {creator.verified && <Verified />}</b><small>Current owner</small></span><Icon name="chevron" size={16} /></button>{artist.id && <div className="detail-artist-follow"><span>Created by <b>{artist.name}</b></span><Button variant="outline" onClick={() => onFollowCreator(artist.id)}><Icon name="heart" size={14} />{creatorFollows.includes(artist.id) ? "Following" : "Follow creator"}</Button></div>}<div className="detail-price"><span><small>{item.saleType === 'Auction' ? item.auctionEnds : item.saleType === 'Offers' ? 'Best offer' : item.saleType === 'Not listed' ? 'Sale status' : 'Current price'}</small><b>{item.saleType === 'Offers' ? item.bestOffer : item.price}</b><em>{item.priceUsd} · {item.chain}</em></span><div className="detail-actions">{isCurrentOwner ? <><span className="detail-owner-note">You own this NFT</span><Button variant="outline" onClick={() => onSell(item)}>List</Button></> : <>{item.tokenId !== undefined && item.contractId && <Button variant="outline" onClick={() => onOffer(item)}>Make offer</Button>}{item.saleType === 'Auction' || item.saleType === 'Buy now' ? <Button onClick={() => onBuy(item)}>{item.saleType === 'Auction' ? 'Place bid' : 'Buy now'} <Icon name="arrow" size={16} /></Button> : null}</>}</div></div><div className="detail-meta"><Meta label="Collection" value={collection.name} onClick={() => onCollection(collection)} /><Meta label="Token standard" value="SEP-50 NFT" />{item.rarity_rank !== null && item.rarity_rank !== undefined && <Meta label="Rarity rank" value={`#${item.rarity_rank}`} />}{item.rarity_score !== null && item.rarity_score !== undefined && <Meta label="Rarity score" value={item.rarity_score.toFixed(3)} />}{(item.attributes ?? []).map((attribute) => <Meta key={`${item.id}-${attribute.trait_type}`} label={attribute.trait_type} value={String(attribute.value)} />)}<Meta label="Owner" value={item.ownedBy} /><Meta label="Minted" value={item.minted} /><Meta label="Royalty" value={item.royalty} /><Meta label="Best offer" value={item.bestOffer ?? '—'} /></div><NftProvenance contractId={item.contractId} tokenId={item.tokenId} /><NftChainActivity contractId={item.contractId} tokenId={item.tokenId} /><SocialPanel item={item} comments={comments[item.id] ?? []} onComment={onComment} liked={liked.includes(item.id)} disliked={disliked.includes(item.id)} onLike={onLike} onDislike={onDislike} onSell={onSell} /></div></div>{matchingOffers.length > 0 && <section className="section-block detail-offers"><div className="section-title"><div><span className="eyebrow">OFFERS ON THIS NFT</span><h3>Review buyer offers</h3></div></div><div className="market-manage">{matchingOffers.map((offer) => <MarketplaceIncomingOfferRow key={`detail-offer-${offer.offer_id}`} offer={offer} onAccept={() => onAcceptOffer(offer.offer_id, offer.contract_id)} onReject={() => onRejectOffer(offer.offer_id, offer.contract_id)} onCounter={(amount) => onCounterOffer(offer.offer_id, amount, offer.contract_id)} />)}</div></section>}{relatedNfts.length > 0 && <section className="detail-more"><div className="section-title"><div><span className="eyebrow">MORE FROM {ownerName.toUpperCase()}</span><h3>Keep exploring</h3></div></div><div className="feed-grid">{relatedNfts.map((next) => <ArtworkCard item={next} key={next.id} saved={saved.includes(next.id)} onSave={() => toggleSaved(next.id)} onOpen={() => openNft(next)} onCreator={() => onCreator(next.creatorId)} onCollection={() => onCollection(collectionFor(next.collectionId))} liked={liked.includes(next.id)} disliked={disliked.includes(next.id)} onLike={() => onLike(next.id)} onDislike={() => onDislike(next.id)} />)}</div></section>}</div>
  }
  if (detail.type === 'creator') {
    const creator = publicCreatorProfile ? creatorFromPublicProfile(publicCreatorProfile) : creatorFor(detail.id, creatorProfiles)
    const creatorId = publicCreatorProfile?.wallet_address ?? creator.id
    const creatorWorks = allNfts.filter((item) => item.creatorId.toLowerCase() === creatorId.toLowerCase() || item.ownerAddress?.toLowerCase() === creatorId.toLowerCase())
    const creatorCollections = allCollections.filter((item) => item.creatorId.toLowerCase() === creatorId.toLowerCase())
    const creatorPosts = publicCreatorProfile ? publicCreatorPosts : posts.filter((post) => post.creator_wallet?.toLowerCase() === creatorId.toLowerCase())
    if (publicCreatorLoading) return <div className="detail-page"><div className="profile-loading"><span className="eyebrow">PUBLIC PROFILE</span><h1>Loading creator…</h1></div></div>
    if (publicCreatorError) return <div className="detail-page"><button className="back-link" onClick={onBack}><Icon name="arrow" size={16} /> Back to feed</button><div className="empty-state profile-not-found"><h1>Creator profile unavailable</h1><p>{publicCreatorError}</p></div></div>
    return <div className="detail-page"><button className="back-link" onClick={onBack}><Icon name="arrow" size={16} /> Back to feed</button><section className="profile-header"><Avatar src={creator.avatar} alt={creator.name} size="lg" ring /><div className="profile-header__copy"><span className="eyebrow">CREATOR PROFILE</span><h1>{creator.name} {creator.verified && <Verified />}</h1><p>{creator.bio}</p>{creator.handle && <span className="profile-handle">{creator.handle}</span>}</div><div className="profile-header__actions"><CopyLinkButton path={`/creator/${encodeURIComponent(creator.publicSlug || creatorId)}`} label="Share profile" />{stellarWallet?.address.toLowerCase() !== creatorId.toLowerCase() && <Button variant="outline" onClick={() => onFollowCreator(creatorId)}><Icon name="heart" size={14} /> {creatorFollows.includes(creatorId) ? 'Following' : 'Follow'} </Button>}</div></section><div className="profile-stats"><span><b>{creator.collectorCount}</b><small>followers</small></span><span><b>{creatorCollections.length || creator.collectionCount}</b><small>collections</small></span><span><b>{creatorWorks.length}</b><small>NFTs</small></span><span><b>{creatorPosts.length}</b><small>posts</small></span></div><section className="section-block profile-work"><div className="section-title"><div><span className="eyebrow">SHARED ART</span><h3>Posts by {creator.name.split(' ')[0]}</h3></div></div>{creatorPosts.length ? <div className="profile-posts">{creatorPosts.map((post) => <PostCard key={post.id} post={post} allNfts={allNfts} onLike={onPostLike} onDislike={onPostDislike} disliked={disliked.includes(`post:${post.id}`)} onComment={onPostComment} onOpenNft={(nftId) => { const item = allNfts.find((nft) => nft.id === nftId); if (item) openNft(item) }} onCreator={onCreator} onCollection={onCollection} collections={allCollections} walletAddress={stellarWallet?.address ?? ''} onBuyNft={onBuy} onOfferNft={onOffer} />)}</div> : <div className="empty-state empty-state--compact"><h3>No posts yet.</h3><p>Shared artwork and updates from this creator will appear here.</p></div>}</section><section className="section-block profile-work"><div className="section-title"><div><span className="eyebrow">NFTs</span><h3>Collectibles by {creator.name.split(' ')[0]}</h3></div></div>{creatorWorks.length ? <div className="feed-grid">{creatorWorks.map((item) => <ArtworkCard item={item} collectionOverride={allCollections.find((collection) => collection.id === item.collectionId)} key={item.id} saved={saved.includes(item.id)} onSave={() => toggleSaved(item.id)} onOpen={() => openNft(item)} onCreator={() => onCreator(item.creatorId)} onCollection={() => onCollection(allCollections.find((collection) => collection.id === item.collectionId) ?? collectionFor(item.collectionId))} liked={liked.includes(item.id)} disliked={disliked.includes(item.id)} onLike={() => onLike(item.id)} onDislike={() => onDislike(item.id)} />)}</div> : <div className="empty-state empty-state--compact"><h3>No NFTs yet.</h3><p>This creator’s artwork will appear here when it is minted or collected.</p></div>}</section><section className="section-block profile-work"><div className="section-title"><div><span className="eyebrow">COLLECTIONS</span><h3>Collections by {creator.name.split(' ')[0]}</h3></div></div>{creatorCollections.length ? <div className="profile-collections">{creatorCollections.map((collection) => <button className="profile-collection-card" key={collection.id} onClick={() => onCollection(collection)}><img src={collection.cover} alt="" /><span><b>{collection.name}</b><small>{collection.items} NFTs · {collection.symbol}</small></span><Icon name="arrow" size={15} /></button>)}</div> : <div className="empty-state empty-state--compact"><h3>No collections yet.</h3><p>Collections created by this creator will appear here.</p></div>}</section></div>
  }
  const collection = detail.item
  const creator = creatorFor(collection.creatorId, creatorProfiles)
  const collectionItems = allNfts.filter((item) => item.collectionId.toLowerCase() === collection.id.toLowerCase())
  const filteredCollectionItems = collectionItems
    .filter((item) => item.title.toLowerCase().includes(collectionSearch.trim().toLowerCase()))
    .sort((a, b) => collectionSort === 'title-az' ? a.title.localeCompare(b.title) : collectionSort === 'title-za' ? b.title.localeCompare(a.title) : collectionSort === 'oldest' ? (a.tokenId ?? 0) - (b.tokenId ?? 0) : (b.tokenId ?? 0) - (a.tokenId ?? 0))
  const isOwner = Boolean(stellarWallet && walletCollections.some((owned) => owned.slug === collection.id))
  return <div className="detail-page collection-page">
    <button className="back-link" onClick={onBack}><Icon name="arrow" size={16} /> Back to collections</button>
    <section className="collection-detail-header collection-page-hero">
      <CollectionCover key={`${collection.id}:${collection.cover}`} cover={collection.cover} name={collection.name} symbol={collection.symbol} className="collection-detail-cover" />
      <div className="collection-detail-header__copy"><span className="eyebrow">{collection.isSample ? 'SAMPLE COLLECTION · STELLAR TESTNET' : 'STELLAR TESTNET COLLECTION'}{collection.symbol ? ` · ${collection.symbol}` : ''}</span><h1>{collection.name}</h1><button className="creator-link" onClick={() => onCreator(creator.id)}><Avatar src={creator.avatar} alt={creator.name} size="xs" />by {creator.name} <Icon name="arrow" size={13} /></button></div>
    </section>
    <div className="collection-share-row"><p className="collection-description">{collection.description}</p><div className="collection-share-actions"><CopyLinkButton path={`/collection/${encodeURIComponent(collection.id)}`} label="Share collection" />{!isOwner && <Button variant="outline" onClick={() => onFollowCollection(collection)}><Icon name="heart" size={14} />{subscribedCollections.includes(collection.id) ? 'Following' : 'Follow collection'}</Button>}</div></div>
    <nav className="collection-page-nav" aria-label="Collection sections"><a href="#collection-artwork">Artwork <span>{collectionItems.length}</span></a><a href="#collection-mint">Mint</a><a href="#collection-offers">Offers</a><a href="#collection-updates">Updates</a></nav>
    <section className="collection-items collection-page-panel" id="collection-artwork">
      <div className="section-title"><div><span className="eyebrow">BROWSE THE SET</span><h3>All works</h3></div><span className="muted-note">{filteredCollectionItems.length} of {collectionItems.length} NFTs</span></div>
      <div className="collection-browse-controls"><label><span className="sr-only">Search NFTs in this collection</span><Icon name="search" size={16} /><input value={collectionSearch} onChange={(event) => setCollectionSearch(event.target.value)} placeholder="Search this collection" /></label><label><span className="sr-only">Sort collection NFTs</span><select value={collectionSort} onChange={(event) => setCollectionSort(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title-az">Name A–Z</option><option value="title-za">Name Z–A</option></select></label></div>
      {filteredCollectionItems.length ? <div className="feed-grid">{filteredCollectionItems.map((item) => <ArtworkCard item={item} collectionOverride={collection} key={item.id} saved={saved.includes(item.id)} onSave={() => toggleSaved(item.id)} onOpen={() => openNft(item)} onCreator={() => onCreator(item.creatorId)} onCollection={() => onCollection(collection)} onSell={() => onSell(item)} liked={liked.includes(item.id)} disliked={disliked.includes(item.id)} onLike={() => onLike(item.id)} onDislike={() => onDislike(item.id)} />)}</div> : <div className="empty-state empty-state--compact"><h3>{collectionItems.length ? 'No NFTs match this search.' : collection.revealed === false ? 'Artwork is unrevealed.' : 'No NFTs in this collection yet.'}</h3><p>{collectionItems.length ? 'Try another title or clear your search.' : collection.revealed === false ? 'Confirmed mint history and drop setup are in the Mint section below. Artwork appears here after reveal.' : 'Use the Mint section below to set up a drop or mint an NFT directly into this collection.'}</p></div>}
    </section>
    <section className="collection-page-panel collection-page-mint" id="collection-mint"><CollectionMintHistory slug={collection.id} /><CollectionMintTimeline collection={collection} wallet={stellarWallet} notify={notify} setMintedNfts={setMintedNfts} onStageMintsConfirmed={onStageMintsConfirmed} onCollectionUpdated={onCollectionUpdated} /></section>
    <CollectionOffersPanel collection={collection} items={collectionItems} wallet={stellarWallet} owner={isOwner} notify={notify} />
    {isOwner && <details className="collection-management-details"><summary>Collection updates and settings</summary><div className="collection-management-details__content"><CreatorRoyaltySettings collection={collection} wallet={stellarWallet} notify={notify} /><CollectionStoryComposer collection={collection} wallet={stellarWallet} notify={notify} onCreate={onCreateCollectionStory} /><CollectionPostComposer collection={collection} onCreate={async (item, caption, media) => { await onCreateCollectionPost(item, caption, media); void fetchPosts(undefined, item.id).then(setCollectionPosts).catch(() => {}) }} /></div></details>}
    <section className="collection-items collection-activity collection-page-panel" id="collection-updates"><div className="section-title"><div><span className="eyebrow">COLLECTION FEED</span><h3>Updates from {collection.name}</h3></div></div>{collectionPostsLoading ? <div className="empty-state empty-state--compact"><h3>Loading collection posts…</h3></div> : collectionPosts.length ? collectionPosts.map((post) => <PostCard key={post.id} post={post} onLike={onPostLike} onDislike={onPostDislike} disliked={disliked.includes(`post:${post.id}`)} onComment={onPostComment} onOpenNft={(nftId) => { const item = allNfts.find((nft) => nft.id === nftId); if (item) openNft(item) }} onCreator={onCreator} onCollection={onCollection} collections={allCollections} allNfts={allNfts} walletAddress={stellarWallet?.address ?? ''} onBuyNft={onBuy} onOfferNft={onOffer} />) : <div className="empty-state empty-state--compact"><h3>No collection posts yet.</h3><p>Announcements published by this collection will appear here.</p></div>}</section>
  </div>
}

function CollectionCover({ cover, name, symbol, className = '' }: { cover: string; name: string; symbol: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [cover])
  return cover && !failed
    ? <img className={`collection-cover-display ${className}`} src={cover} alt={`${name} collection cover`} onError={() => setFailed(true)} />
    : <div className={`collection-cover-display is-empty ${className}`} aria-label={`${name} has no collection image`}><Icon name="image" size={32} /><b>{symbol || name.slice(0, 2).toUpperCase()}</b><span>No collection image</span></div>
}

function CollectionPublicInfo({ collection, owner, wallet, notify, onUpdated }: { collection: Collection; owner: boolean; wallet: StellarWallet | null; notify: (message: string) => void; onUpdated: (changes: Partial<Collection>) => void }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [website, setWebsite] = useState(collection.websiteUrl ?? '')
  const [socials, setSocials] = useState<Record<string, string>>(collection.socialLinks ?? {})
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [removeCover, setRemoveCover] = useState(false)
  const [coverPreview, setCoverPreview] = useState('')
  useEffect(() => {
    setWebsite(collection.websiteUrl ?? '')
    setSocials(collection.socialLinks ?? {})
    setCoverFile(null)
    setRemoveCover(false)
  }, [collection.id, collection.websiteUrl, collection.socialLinks, collection.cover])
  useEffect(() => {
    if (!coverFile) { setCoverPreview(''); return }
    const url = URL.createObjectURL(coverFile)
    setCoverPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [coverFile])
  const imagePreview = coverPreview || (!removeCover ? collection.cover : '')
  const links = [
    ...(collection.websiteUrl ? [{ label: 'Website', href: collection.websiteUrl }] : []),
    ...Object.entries(collection.socialLinks ?? {}).map(([key, href]) => ({ label: key === 'x' ? 'X' : key[0].toUpperCase() + key.slice(1), href })),
  ]
  const save = async () => {
    if (!wallet) { notify('Connect your wallet to edit collection information'); return }
    setSaving(true)
    try {
      let cover: string | undefined
      if (coverFile) {
        const uploaded = await uploadMedia(coverFile, collection.id, { walletAddress: wallet.address })
        cover = uploaded.original.r2Url ?? uploaded.original.cloudinaryUrl ?? undefined
        if (!cover) throw new Error('The collection image upload did not return a public URL')
      } else if (removeCover) cover = ''
      const result = await updateCollectionProfile(wallet.address, collection.id, { websiteUrl: website.trim(), socialLinks: socials, ...(cover !== undefined ? { cover } : {}) })
      const changes: Partial<Collection> = { websiteUrl: result.websiteUrl ?? null, socialLinks: result.socialLinks }
      if (cover !== undefined) changes.cover = result.cover
      onUpdated(changes)
      setCoverFile(null)
      setRemoveCover(false)
      setEditing(false)
      notify('Collection details updated')
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save collection information') }
    finally { setSaving(false) }
  }
  const setSocial = (key: string, value: string) => setSocials((current) => ({ ...current, [key]: value }))
  if (!owner && !links.length && !collection.totalSupply) return null
  return <section className="collection-public-info collection-page-subsection"><div className="section-title"><div><span className="eyebrow">COLLECTION DETAILS</span><h3>{owner ? 'Shape your collection' : `Find ${collection.name} online`}</h3></div>{owner && <Button variant="outline" onClick={() => setEditing((value) => !value)}>{editing ? 'Close editor' : 'Edit collection'}</Button>}</div>{collection.totalSupply && <p className="collection-supply-summary">{collection.items} minted <span>of {collection.totalSupply.toLocaleString()} total</span></p>}{links.length ? <nav className="collection-public-links" aria-label={`${collection.name} website and social media`}>{links.map((link) => <a href={link.href} key={link.label} target="_blank" rel="noreferrer">{link.label}<Icon name="arrow" size={13} /></a>)}</nav> : !owner ? null : <p className="muted-note">Add your website and social accounts here. They’ll be visible to everyone who visits this collection.</p>}{editing && <div className="collection-info-editor"><div className="collection-cover-editor"><div><b>Collection image</b><small>Shown on this dashboard and across your public collection cards.</small></div>{imagePreview ? <img className="collection-cover-editor__preview" src={imagePreview} alt="Collection cover preview" /> : <CollectionCover cover="" name={collection.name} symbol={collection.symbol} className="collection-cover-editor__preview" />}<div className="collection-cover-editor__actions"><label className="button button--outline">{coverFile ? 'Choose another image' : 'Upload image'}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) { notify('Choose an image that is 10 MB or smaller'); event.currentTarget.value = ''; return } setRemoveCover(false); setCoverFile(file) }} /></label>{collection.cover && <Button variant="quiet" onClick={() => { setCoverFile(null); setRemoveCover(true) }} disabled={saving}>Remove image</Button>}</div></div><p className="collection-link-hint">Paste a link with or without https://. You can enter X, Instagram, and YouTube handles too.</p><label className="collection-info-editor__wide">Website<input type="text" inputMode="url" value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="your-site.com" /></label><label>Instagram<input type="text" inputMode="url" value={socials.instagram ?? ''} onChange={(event) => setSocial('instagram', event.target.value)} placeholder="instagram.com/username or @username" /></label><label>X<input type="text" inputMode="url" value={socials.x ?? ''} onChange={(event) => setSocial('x', event.target.value)} placeholder="x.com/username or @username" /></label><label>Discord<input type="text" inputMode="url" value={socials.discord ?? ''} onChange={(event) => setSocial('discord', event.target.value)} placeholder="discord.gg/invite" /></label><label>YouTube<input type="text" inputMode="url" value={socials.youtube ?? ''} onChange={(event) => setSocial('youtube', event.target.value)} placeholder="youtube.com/@channel or @channel" /></label><div className="collection-info-editor__actions"><Button variant="outline" onClick={() => { setEditing(false); setCoverFile(null); setRemoveCover(false) }} disabled={saving}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button></div></div>}</section>
}
function CollectionPostComposer({ collection, onCreate }: { collection: Collection; onCreate: (collection: Collection, caption: string, mediaUrl: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [caption, setCaption] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return <section className="collection-post-composer"><div className="section-title"><div><span className="eyebrow">POST AS {collection.name.toUpperCase()}</span><h3>Share a collection update</h3></div><Button variant="outline" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Write update'}</Button></div>{open && <div className="compose-box"><textarea value={caption} onChange={(event) => setCaption(event.target.value)} rows={3} placeholder={`Tell collectors what’s happening with ${collection.name}…`} aria-label="Collection announcement" /><input value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder="Media URL (optional)" aria-label="Collection post media URL" /><div className="compose-box__footer"><small>This will appear in the community feed as {collection.name}.</small><Button disabled={submitting || (!caption.trim() && !mediaUrl.trim())} onClick={async () => { setSubmitting(true); try { await onCreate(collection, caption, mediaUrl); setCaption(''); setMediaUrl(''); setOpen(false) } finally { setSubmitting(false) } }}>{submitting ? 'Posting…' : 'Post as collection'} <Icon name="arrow" size={14} /></Button></div></div>}</section>
}

function CollectionStoryComposer({ collection, wallet, notify, onCreate }: { collection: Collection; wallet: StellarWallet | null; notify: (message: string) => void; onCreate: (collection: Collection, caption: string, mediaUrl: string) => Promise<void> }) {
  const [caption, setCaption] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  return <section className="collection-post-composer collection-story-composer"><div className="section-title"><div><span className="eyebrow">STORY · 24 HOURS</span><h3>Share with followers</h3></div><Button variant="outline" onClick={() => setOpen((value) => !value)}>{open ? 'Close' : 'Add story'}</Button></div>{open && <div className="compose-box"><textarea rows={2} maxLength={500} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder={`A quick update from ${collection.name}…`} aria-label="Story caption" /><label className="button button--outline story-file-picker">{mediaFile ? mediaFile.name : 'Choose photo or video'}<input type="file" accept="image/*,video/mp4,video/webm,video/quicktime" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; if (file && file.size > 50 * 1024 * 1024) { notify('Choose a photo or video under 50 MB'); event.currentTarget.value = ''; return } setMediaFile(file); setMediaUrl('') }} /></label><input value={mediaUrl} onChange={(event) => { setMediaUrl(event.target.value); setMediaFile(null) }} placeholder="Or paste a public media URL" aria-label="Story media URL" /><div className="compose-box__footer"><small>Followers and current holders of this collection can see its story.</small><Button disabled={saving || (!caption.trim() && !mediaUrl.trim() && !mediaFile)} onClick={async () => { setSaving(true); try { let url = mediaUrl.trim(); if (mediaFile) { if (!wallet) throw new Error('Sign in to upload story media'); const uploaded = await uploadMedia(mediaFile, collection.id, { walletAddress: wallet.address }); url = uploaded.original.r2Url ?? uploaded.original.cloudinaryUrl ?? ''; if (!url) throw new Error('The story upload did not return a public URL') } await onCreate(collection, caption, url); setCaption(''); setMediaUrl(''); setMediaFile(null); setOpen(false) } catch (error) { notify(error instanceof Error ? error.message : 'Unable to share story') } finally { setSaving(false) }}}>{saving ? 'Sharing…' : 'Share story'} <Icon name="arrow" size={14} /></Button></div></div>}</section>
}

function ThreadedCommentList({ comments, onReply }: { comments: SocialComment[]; onReply: (parentId: number | string, text: string) => Promise<void> }) {
  const [replyTo, setReplyTo] = useState<number | string | null>(null)
  const [draft, setDraft] = useState('')
  const childMap = new Map<string, SocialComment[]>()
  const ids = new Set(comments.map((comment) => String(comment.id)))
  for (const comment of comments) {
    const parentId = comment.parent_id === null || comment.parent_id === undefined || !ids.has(String(comment.parent_id)) ? '' : String(comment.parent_id)
    childMap.set(parentId, [...(childMap.get(parentId) ?? []), comment])
  }
  const render = (comment: SocialComment, depth = 0): ReactNode => <div className="thread-comment" key={String(comment.id)}>
    <div className="thread-comment__content"><b>Collector</b><p>{comment.body}</p><button type="button" onClick={() => { setReplyTo(replyTo === comment.id ? null : comment.id); setDraft('') }}>Reply</button></div>
    {replyTo === comment.id && <form className="post-card__comment thread-comment__form" onSubmit={async (event) => { event.preventDefault(); if (!draft.trim()) return; await onReply(comment.id, draft); setDraft(''); setReplyTo(null) }}><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a reply…" aria-label="Write a reply" /><button type="submit">Reply</button></form>}
    {depth < 8 && (childMap.get(String(comment.id)) ?? []).map((child) => render(child, depth + 1))}
  </div>
  return <div className="thread-comments">{(childMap.get('') ?? []).map((comment) => render(comment))}</div>
}

function SocialPanel({ item, comments, onComment, liked, disliked, onLike, onDislike, onSell }: { item: NFT; comments: SocialComment[]; onComment: (id: string, text: string, parentId?: number | string | null) => Promise<void>; liked: boolean; disliked: boolean; onLike: (id: string) => void; onDislike: (id: string) => void; onSell: (item: NFT) => void }) {
  const [draft, setDraft] = useState('')
  return <section className="social-panel"><div className="social-panel__actions"><button className={liked ? 'is-active-up' : ''} aria-label="Thumbs up" onClick={() => onLike(item.id)}><Icon name="thumbUp" size={17} /> {item.likes}</button><button className={disliked ? 'is-active-down' : ''} aria-label="Thumbs down" onClick={() => onDislike(item.id)}><Icon name="thumbDown" size={17} /></button><button onClick={() => document.getElementById('comment-input')?.focus()}><Icon name="comment" size={17} /> {comments.length || item.comments} comments</button><Button variant="quiet" onClick={() => onSell(item)}>Sell</Button></div><ThreadedCommentList comments={comments} onReply={(parentId, text) => onComment(item.id, text, parentId)} /><form onSubmit={async (event) => { event.preventDefault(); if (!draft.trim()) return; await onComment(item.id, draft); setDraft('') }}><input id="comment-input" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a comment…" aria-label="Add a comment" /><button type="submit">Post</button></form></section>}

function PostCard({ post, allNfts = [], onLike, onDislike, disliked, onComment, onTipPost, onOpenNft, onCreator, onCollection, collections: availableCollections = [], walletAddress = '', onBuyNft, onOfferNft }: { post: PostRecord; allNfts?: NFT[]; onLike: (id: number) => void; onDislike: (id: number) => void; disliked: boolean; onComment: (id: number, text: string, parentId?: number | string | null) => Promise<void>; onTipPost?: (id: number, recipient: string, amount: string, onProgress: (stage: 'preparing' | 'awaiting-wallet' | 'confirming') => void) => Promise<{ hash: string; amount: string; tipsCount?: number }>; onOpenNft: (nftId: string) => void; onCreator: (creatorId: string) => void; onCollection?: (collection: Collection) => void; collections?: Collection[]; walletAddress?: string; onBuyNft?: (item: NFT) => void; onOfferNft?: (item: NFT) => void }) {
  const linked = post.linked_nft_id ? [...allNfts, ...nfts].find((n) => n.id === post.linked_nft_id) : undefined
  const isLinkedNftOwner = Boolean(linked?.ownerAddress && walletAddress && linked.ownerAddress.toLowerCase() === walletAddress.toLowerCase())
  const creatorId = post.author_type === 'user' ? post.creator_wallet || post.tip_recipient || (/^G[A-Z2-7]{55}$/i.test(post.author) ? post.author : linked?.creatorId ?? null) : (creators.find((c) => c.id === post.author) ? post.author : null)
  const [commentOpen, setCommentOpen] = useState(false)
  const [tipOpen, setTipOpen] = useState(false)
  const canTip = Boolean(onTipPost && post.author_type === 'user' && post.post_kind === 'post' && !post.collection_id && post.media_url && post.tip_recipient && !post.linked_nft_id && !post.is_me && post.tip_recipient.toLowerCase() !== walletAddress.toLowerCase())
  return (
    <article className="post-card" id={`post-${post.id}`}>
      <div className="post-card__head">
        <Avatar src={post.avatar} alt={publicPostAuthorName(post)} size="sm" />
        <div>
          {post.author_type === 'user' && creatorId ? <button className="post-author-link" onClick={() => onCreator(creatorId)}>{publicPostAuthorName(post)}</button> : <strong>{publicPostAuthorName(post)}</strong>}
          {post.author_type === 'collection' && post.collection_id ? <button className="creator-link" onClick={() => onCollection?.(availableCollections.find((collection) => collection.id === post.collection_id) ?? collectionFor(post.collection_id!))}>Collection post · View collection</button> : creatorId && <button className="creator-link" onClick={() => onCreator(creatorId)}>View profile</button>}
        </div>
      </div>
      {post.media_url && <div className="post-card__media-frame">{post.media_type === 'video' ? <video className="post-card__media" src={mediaSource(post.media_url)} controls playsInline /> : <img className="post-card__media" src={mediaSource(post.media_url)} alt={post.caption} onError={(event) => {
        const image = event.currentTarget
        if (!image.dataset.proxyAttempted && /^https:\/\/res\.cloudinary\.com\//i.test(image.src)) {
          image.dataset.proxyAttempted = 'true'
          image.src = `/api/media/proxy?url=${encodeURIComponent(image.src)}`
        } else {
          image.parentElement?.classList.add('is-unavailable')
        }
      }} />}<span className="post-card__media-fallback" aria-hidden="true"><Icon name="spark" size={22} /><b>Media unavailable</b></span></div>}
      {post.author_type === 'collection' ? <span className="post-card__kind is-collection"><Icon name="grid" size={12} /> Collection update</span> : post.post_kind === 'drop' && <span className="post-card__kind is-drop"><Icon name="bookmark" size={12} /> Drop announcement</span>}
      <div className="post-card__body">
        {post.caption && <p>{post.caption}</p>}
        {post.post_kind === 'drop' && linked ? (
          <div className="post-card__drop"><img src={linked.image} alt={linked.title} /><span><b>{linked.title}</b><small>{post.price_xlm ? `${Number(post.price_xlm).toFixed(2)} XLM` : linked.saleType} · announcement</small><FeedNftMarketButtons item={linked} isOwner={isLinkedNftOwner} onOpen={() => onOpenNft(linked.id)} onBuy={onBuyNft ? () => onBuyNft(linked) : undefined} onOffer={onOfferNft ? () => onOfferNft(linked) : undefined} /></span></div>
        ) : linked ? (
          <div className="post-card__nft"><img src={linked.image} alt={linked.title} /><span><b>{linked.title}</b><small>Mentioned artwork · {linked.price}</small><FeedNftMarketButtons item={linked} isOwner={isLinkedNftOwner} onOpen={() => onOpenNft(linked.id)} onBuy={onBuyNft ? () => onBuyNft(linked) : undefined} onOffer={onOfferNft ? () => onOfferNft(linked) : undefined} /></span></div>
        ) : null}
        {commentOpen && <ThreadedCommentList comments={post.comments} onReply={(parentId, text) => onComment(post.id, text, parentId)} />}
        {commentOpen && <form className="post-card__comment" onSubmit={async (event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('body') as HTMLInputElement; if (!input.value.trim()) return; await onComment(post.id, input.value); input.value = '' }}>
          <input id={`post-comment-${post.id}`} name="body" placeholder="Add a comment…" aria-label="Add a comment" />
          <button type="submit">Post</button>
        </form>}
      </div>
      <div className="post-card__actions">
        <button className={post.liked ? 'is-active-up' : ''} onClick={() => onLike(post.id)} aria-label="Thumbs up" title="Like"><Icon name="thumbUp" size={19} /><span>{post.likes}</span></button>
        <button className={disliked ? 'is-active-down' : ''} onClick={() => onDislike(post.id)} aria-label="Thumbs down" title="Dislike"><Icon name="thumbDown" size={19} /><span>{post.dislikes ?? 0}</span></button>
        <button onClick={() => setCommentOpen((open) => !open)} aria-label="View comments" title="Comments"><Icon name="comment" size={19} /><span>{post.comments.length}</span></button>
        {canTip && <button className="post-card__tip-action" onClick={() => setTipOpen(true)} aria-label="Tip this creator" title="Support this artwork with an XLM tip"><Icon name="spark" size={18} /><span>Tip</span>{(post.tips_count ?? 0) > 0 && <small>{post.tips_count} · {Number(post.tips_total_xlm ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM</small>}</button>}
        <SharePostButton post={post} />
      </div>
      {tipOpen && post.tip_recipient && onTipPost && <TipPostDialog post={post} recipient={post.tip_recipient} onClose={() => setTipOpen(false)} onSubmit={(amount, onProgress) => onTipPost(post.id, post.tip_recipient!, amount, onProgress)} />}
    </article>
  )
}

function TipPostDialog({ post, recipient, onClose, onSubmit }: { post: PostRecord; recipient: string; onClose: () => void; onSubmit: (amount: string, onProgress: (stage: 'preparing' | 'awaiting-wallet' | 'confirming') => void) => Promise<{ hash: string; amount: string }> }) {
  const [amount, setAmount] = useState('1')
  const [progress, setProgress] = useState<'idle' | 'preparing' | 'awaiting-wallet' | 'confirming' | 'complete'>('idle')
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<{ hash: string; amount: string } | null>(null)
  const busy = ['preparing', 'awaiting-wallet', 'confirming'].includes(progress)
  const validAmount = /^\d+(?:\.\d{1,7})?$/.test(amount) && Number(amount) > 0 && Number(amount) <= 10_000
  const confirmTip = async () => {
    setError('')
    setProgress('preparing')
    try {
      const result = await onSubmit(amount, setProgress)
      setReceipt(result)
      setProgress('complete')
    } catch (cause) {
      setProgress('idle')
      setError(cause instanceof Error ? cause.message : 'The tip could not be sent')
    }
  }
  return <div className="modal-backdrop tip-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <section className="wallet-modal tip-modal" role="dialog" aria-modal="true" aria-labelledby={`tip-title-${post.id}`} aria-busy={busy}>
      <button className="modal-close" type="button" onClick={onClose} aria-label="Close tip dialog" disabled={busy}><Icon name="close" size={18} /></button>
      {progress === 'complete' && receipt ? <>
        <span className="eyebrow">CONFIRMED ON STELLAR {import.meta.env.VITE_STELLAR_NETWORK === 'PUBLIC' ? 'MAINNET' : 'TESTNET'}</span>
        <h2 id={`tip-title-${post.id}`}>Art supported</h2>
        <p>{receipt.amount} XLM was sent directly to this creator’s wallet.</p>
        <a className="tip-modal__receipt" href={`${STELLAR_EXPLORER_URL}/tx/${receipt.hash}`} target="_blank" rel="noreferrer">View transaction on Stellar Expert <Icon name="arrow" size={14} /></a>
        <div className="tip-modal__actions"><Button onClick={onClose}>Done</Button></div>
      </> : <>
        <span className="eyebrow">SUPPORT THE ARTIST</span>
        <h2 id={`tip-title-${post.id}`}>Tip this artwork</h2>
        <p>Your XLM goes directly from your wallet to the creator. StellaNova takes no fee.</p>
        <div className="tip-modal__art"><Avatar src={post.avatar} alt={publicPostAuthorName(post)} size="sm" /><span><b>{publicPostAuthorName(post)}</b><small>{post.caption || 'Shared artwork'}</small></span></div>
        <div className="tip-modal__presets" aria-label="Suggested tip amounts">{['1', '5', '10'].map((value) => <button key={value} type="button" className={amount === value ? 'is-active' : ''} onClick={() => setAmount(value)} disabled={busy}>{value} XLM</button>)}</div>
        <label className="tip-modal__amount">Custom amount in XLM<input className="offer-input" inputMode="decimal" type="text" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} placeholder="1.00" /></label>
        <small className="tip-modal__recipient">To {shortenStellarAddress(recipient)} · Stellar {import.meta.env.VITE_STELLAR_NETWORK === 'PUBLIC' ? 'Mainnet' : 'Testnet'}</small>
        {busy && <p className="tip-modal__status" role="status">{progress === 'preparing' ? 'Preparing your XLM payment…' : progress === 'awaiting-wallet' ? 'Approve the tip in your wallet…' : 'Tip submitted. Waiting for Stellar confirmation…'}</p>}
        {error && <p className="wallet-overview__error" role="alert">{error}</p>}
        <div className="tip-modal__actions"><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void confirmTip()} disabled={!validAmount || busy}>{busy ? 'Sending tip…' : `Tip ${validAmount ? amount : ''} XLM`}</Button></div>
      </>}
    </section>
  </div>
}

function CreatorOnboardingModal({ name, setName, symbol, setSymbol, description, setDescription, totalSupply, setTotalSupply, coverImage, setCoverImage, creating, onClose, onCreate }: { name: string; setName: (v: string) => void; symbol: string; setSymbol: (v: string) => void; description: string; setDescription: (v: string) => void; totalSupply: string; setTotalSupply: (v: string) => void; coverImage: File | null; setCoverImage: (file: File | null) => void; creating: boolean; onClose: () => void; onCreate: () => void }) {
  const [coverPreview, setCoverPreview] = useState('')
  const [coverError, setCoverError] = useState('')
  useEffect(() => {
    if (!coverImage) { setCoverPreview(''); return }
    const url = URL.createObjectURL(coverImage)
    setCoverPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [coverImage])
  const chooseCover = (file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) {
      setCoverError('Choose an image that is 10 MB or smaller.')
      return
    }
    setCoverError('')
    setCoverImage(file)
  }
  const canCreate = Boolean(name.trim() && symbol.trim() && coverImage && !coverError && (!totalSupply.trim() || (Number.isSafeInteger(Number(totalSupply)) && Number(totalSupply) >= 1 && Number(totalSupply) <= 10000000)) && !creating)
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !creating && onClose()}><div className="wallet-modal collection-create-modal" role="dialog" aria-modal="true" aria-labelledby="creator-title"><button className="modal-close" onClick={onClose} aria-label="Close" disabled={creating}><Icon name="close" size={18} /></button><div className="wallet-modal__icon"><Icon name="bookmark" size={24} /></div><span className="eyebrow">NEW COLLECTION</span><h2 id="creator-title">Create your<br /><i>collection.</i></h2><p>Set the collection details, then mint your artwork directly into it. NFTs go to your wallet and appear in the collection. You can add more at any time; public sale stages are optional.</p><div className="collection-create-form"><label className="collection-create-field"><span>Collection name</span><input className="offer-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Journey" aria-label="Collection name" /></label><label className="collection-create-field"><span>Ticker / symbol</span><input className="offer-input" value={symbol} maxLength={20} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="e.g. JJC" aria-label="Collection ticker" /></label><div className="collection-create-field collection-create-field--wide"><span>Display image</span><label className="collection-cover-picker">{coverPreview ? <img src={coverPreview} alt="Collection display image preview" /> : <span className="collection-cover-picker__empty"><Icon name="image" size={25} /><b>Choose display image</b><small>PNG, JPG, WebP, or GIF · up to 10 MB</small></span>}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Collection display image" onChange={(event) => chooseCover(event.target.files?.[0] ?? null)} /></label>{coverImage && <small>{coverImage.name}</small>}{coverError && <small className="collection-cover-error" role="alert">{coverError}</small>}</div><label className="collection-create-field collection-create-field--wide"><span>Description</span><textarea className="offer-input" rows={3} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this collection about?" aria-label="Collection description" /></label><label className="collection-create-field collection-create-field--wide"><span>Total supply (optional)</span><input className="offer-input" type="number" min="1" max="10000000" step="1" value={totalSupply} onChange={(event) => setTotalSupply(event.target.value)} placeholder="Open supply" aria-label="Collection total supply (optional)" /><small>Leave blank for an open collection. Add a cap only if you already know the maximum. A public sale stage can still set its own allocation.</small></label><div className="collection-create-actions"><Button variant="outline" onClick={onClose} disabled={creating}>Cancel</Button><Button onClick={onCreate} disabled={!canCreate}>{creating ? 'Creating collection…' : 'Create collection'} {!creating && <Icon name="arrow" size={15} />}</Button></div></div></div></div>
}

function CopyLinkButton({ path, label }: { path: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const [route = '', entity = ''] = path.split('/').filter(Boolean)
    const kind = route === 'collection' ? 'collection' : 'nft'
    const url = createTrackedShareUrl(path, kind, decodeURIComponent(entity))
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url)
      else {
        const input = document.createElement('textarea'); input.value = url; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select()
        const success = document.execCommand('copy'); input.remove(); if (!success) throw new Error('Clipboard unavailable')
      }
      setCopied(true); window.setTimeout(() => setCopied(false), 2200)
    } catch { window.prompt('Copy this link', url) }
  }
  return <button type="button" className="copy-link-button" onClick={() => void copy()}><Icon name="share" size={15} />{copied ? 'Link copied' : label}</button>
}

function SharePostButton({ post }: { post: PostRecord }) {
  const [copied, setCopied] = useState(false)
  const share = async () => {
    const url = createTrackedShareUrl(`/post/${post.id}`, 'post', String(post.id))
    const title = `${publicPostAuthorName(post)} on StellaNova`
    const text = post.caption?.trim() || `View ${publicPostAuthorName(post)}'s post on StellaNova.`
    try {
      if (navigator.share) await navigator.share({ title, text, url })
      else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2200)
      } else window.prompt('Copy this post link', url)
    } catch (cause) {
      if (cause instanceof Error && cause.name !== 'AbortError') window.prompt('Copy this post link', url)
    }
  }
  return <button type="button" onClick={() => void share()} aria-label={copied ? 'Post link copied' : 'Share post'} title={copied ? 'Link copied' : 'Share post'}><Icon name="share" size={19} /><span>{copied ? 'Copied' : 'Share'}</span></button>
}

function ShareNftButton({ item }: { item: NFT }) {
  const [copied, setCopied] = useState(false)
  const share = async () => {
    const url = createTrackedShareUrl(`/nft/${encodeURIComponent(item.id)}`, 'nft', item.id)
    const text = `View ${item.title} on StellaNova.`
    try {
      if (navigator.share) await navigator.share({ title: item.title, text, url })
      else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2200)
      } else window.prompt('Copy this NFT link', url)
    } catch (cause) {
      if (cause instanceof Error && cause.name !== 'AbortError') window.prompt('Copy this NFT link', url)
    }
  }
  return <button type="button" className="save-button save-button--card art-card__share-button" onClick={() => void share()} aria-label={copied ? 'NFT link copied' : 'Share NFT'} title={copied ? 'Link copied' : 'Share NFT'}><Icon name="share" size={18} />{copied && <span>Copied</span>}</button>
}

function MintModal({ open, firstCollectionMintStep, onClose, targetCollection, success, onDone, title, setTitle, description, setDescription, artwork, setArtwork, artworkUrl, setArtworkUrl, media, setMedia, traits, setTraits, error, onMint, minting }: { open: boolean; firstCollectionMintStep: boolean; targetCollection: WalletCollection | null; onClose: () => void; success: { tokenId: number; title: string; image: string; contractId: string; txHash: string; indexed?: boolean } | null; onDone: () => void; title: string; setTitle: (v: string) => void; description: string; setDescription: (v: string) => void; artwork: File | null; setArtwork: (v: File | null) => void; artworkUrl: string; setArtworkUrl: (v: string) => void; media: File | null; setMedia: (v: File | null) => void; traits: string; setTraits: (v: string) => void; error: string; onMint: () => void; minting: boolean }) {
  if (!open) return null
  const previewUrl = artworkUrl.startsWith('http://') || artworkUrl.startsWith('https://') ? artworkUrl : ''
  return <div className="modal-backdrop create-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="mint-title">
    <header className="create-modal__header"><button className="create-modal__back" onClick={onClose} aria-label="Back"><Icon name="arrow" size={23} /></button><h2 id="mint-title">{success ? 'Mint successful' : firstCollectionMintStep ? 'Add first NFT' : 'Create NFT'}</h2>{success ? <button className="create-modal__share" onClick={onDone}>{targetCollection ? 'Collection' : 'Portfolio'}</button> : <button className="create-modal__share" onClick={onMint} disabled={minting || (!artwork && !artworkUrl.trim()) || !title.trim()}>{minting ? 'Minting…' : 'Mint'}</button>}</header>
    {success ? <div className="create-modal__content create-modal__mint-success" role="status" aria-live="polite"><img src={success.image} alt={success.title} /><span className="eyebrow">CONFIRMED ON STELLAR TESTNET</span><h3>{success.title}</h3><p>NFT #{success.tokenId} is in your wallet{targetCollection ? ` and in ${targetCollection.name}.` : "."}</p><p className="muted-note">{success.indexed ? 'Mint successful and indexed.' : 'Mint confirmed. Portfolio indexing is in progress; you do not need to mint again.'}</p><div className="collection-create-actions"><Button variant="outline" onClick={onDone}>{targetCollection ? `View ${targetCollection.name}` : 'View portfolio'} <Icon name="arrow" size={15} /></Button></div></div> :
    <div className="create-modal__content create-modal__content--mint">
      <div className="create-modal__preview"><CreateArtworkPreview file={artwork} src={previewUrl} title={title || 'NFT artwork'} emptyText={null} />{!artwork && !previewUrl && <label className="create-modal__choose-media"><Icon name="image" size={24} /><span>Select artwork</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { setArtwork(event.target.files?.[0] ?? null); if (event.target.files?.[0]) setArtworkUrl('') }} /></label>}</div>
      <div className="create-modal__editor create-modal__editor--mint">{firstCollectionMintStep && <div className="collection-create-step"><span className="eyebrow">COLLECTION CREATED · STEP 2 OF 2</span><p>Your collection is ready. Add its first artwork now, or close this form and come back later.</p></div>}<div className="create-modal__mint-kicker">{targetCollection ? `MINT INTO ${targetCollection.name.toUpperCase()}` : 'STELLAR TESTNET · NFT DETAILS'}</div>{targetCollection && <p className="mint-collection-context">This NFT will be minted to your wallet and added to this collection.</p>}{firstCollectionMintStep && artwork && <p className="mint-collection-context">Your collection image is preloaded as the first NFT artwork. You can replace it below.</p>}
        {error && <div role="alert" className="detail-note"><Icon name="activity" size={16} /><span><b>{error.includes('confirmed on Stellar Testnet') ? 'Mint confirmed; indexing pending' : 'Mint failed'}</b><small>{error}</small></span></div>}
        <label className="create-modal__field"><span>Title</span><input className="offer-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="NFT title" /></label>
        <label className="create-modal__field"><span>Description</span><textarea className="offer-input" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the artwork" /></label>
        <label className="create-modal__field"><span>Artwork file</span><input className="offer-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { setArtwork(event.target.files?.[0] ?? null); if (event.target.files?.[0]) setArtworkUrl('') }} />{artwork && <small>{artwork.name}</small>}</label>
        <label className="create-modal__field"><span>Or hosted artwork URL / IPFS</span><input className="offer-input" value={artworkUrl} onChange={(event) => { setArtworkUrl(event.target.value); if (event.target.value) setArtwork(null) }} placeholder="https://… or ipfs://…" /></label>
        <label className="create-modal__field"><span>Animation, audio, or 3D file (optional)</span><input className="offer-input" type="file" accept="video/mp4,video/webm,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,.glb,.gltf" onChange={(event) => setMedia(event.target.files?.[0] ?? null)} />{media && <small>{media.name}</small>}</label>
        <label className="create-modal__field"><span>Traits (one per line: name: value)</span><textarea className="offer-input" rows={3} value={traits} onChange={(event) => setTraits(event.target.value)} placeholder={'Background: Blue\nEyes: Star'} /></label>
      </div>
    </div>}
  </section></div>
}

function CreateChooser({ onClose, onPost, onMint }: { onClose: () => void; onPost: () => void; onMint: () => void }) {
  return <div className="modal-backdrop create-chooser-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="create-chooser" role="dialog" aria-modal="true" aria-labelledby="create-chooser-title"><button className="modal-close" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button><span className="eyebrow">CREATE</span><h2 id="create-chooser-title">Make art part of the community.</h2><p>Share artwork directly to the feed. Minting is optional; creators can receive direct XLM tips for art that is not an NFT.</p><div className="create-chooser__options"><button onClick={onPost}><span className="create-chooser__icon"><Icon name="spark" size={20} /></span><b>Share art</b><small>Post your image or video, add a caption, and let people support your work.</small></button><button onClick={onMint}><span className="create-chooser__icon"><Icon name="bookmark" size={20} /></span><b>Quick mint</b><small>Turn finished artwork into a Stellar NFT and share it with the same community.</small></button></div></div></div>
}

function FeedCollectibleCard({ item, collection, saved, liked, disliked, comments, onOpen, onSave, onLike, onDislike, onComment, onCollection }: { item: NFT; collection: Collection; saved: boolean; liked: boolean; disliked: boolean; comments: SocialComment[]; onOpen: () => void; onSave: () => void; onLike: () => void; onDislike: () => void; onComment: (text: string, parentId?: number | string | null) => Promise<void>; onCollection: () => void }) {
  const creatorProfiles = useContext(CreatorProfilesContext)
  const creator = creatorFor(item.creatorId, creatorProfiles)
  const [commentOpen, setCommentOpen] = useState(false)
  const feedAuthor = creator.name || collection.name
  const feedComments = commentOpen ? <div className="art-card__feed-comments"><ThreadedCommentList comments={comments} onReply={(parentId, text) => onComment(text, parentId)} /><form className="post-card__comment" onSubmit={async (event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('body') as HTMLInputElement; if (!input.value.trim()) return; await onComment(input.value); input.value = '' }}><input name="body" placeholder="Add a comment…" aria-label="Add a comment" /><button type="submit">Post</button></form></div> : null
  return <ArtworkCard item={item} collectionOverride={collection} saved={saved} onSave={onSave} onOpen={onOpen} onCreator={() => {}} onCollection={onCollection} liked={liked} disliked={disliked} onLike={onLike} onDislike={onDislike} feedHeader={{ name: feedAuthor, avatar: creator.avatar || collection.cover, date: item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '' }} onCommentToggle={() => setCommentOpen((open) => !open)} commentCount={comments.length} feedComments={feedComments} showShare />
}

function FeedNftMarketButtons({ item, isOwner, onBuy, onOffer, onOpen }: { item: NFT; isOwner: boolean; onBuy?: () => void; onOffer?: () => void; onOpen?: () => void }) {
  const marketActions = useContext(NftCardActionsContext)
  const activeListing = item.contractId && item.tokenId !== undefined
    ? marketActions.activeListings.find((listing) => listing.nft_contract.toLowerCase() === item.contractId!.toLowerCase() && listing.token_id === item.tokenId)
    : undefined
  const activeAuction = item.contractId && item.tokenId !== undefined
    ? marketActions.activeAuctions.find((auction) => auction.nft_contract.toLowerCase() === item.contractId!.toLowerCase() && auction.token_id === item.tokenId)
    : undefined
  const incomingOffer = isOwner && item.contractId && item.tokenId !== undefined
    ? marketActions.marketplace?.incomingOffers.find((offer) => offer.nft_contract.toLowerCase() === item.contractId!.toLowerCase() && offer.token_id === item.tokenId)
    : undefined
  return <span className="post-card__market-actions">{onOpen && <Button className="feed-market-action" variant="outline" onClick={onOpen}>View NFT <Icon name="arrow" size={13} /></Button>}{isOwner ? <>{activeAuction ? <>{marketActions.latestLedger >= activeAuction.ends_at && <Button className="feed-market-action" onClick={() => marketActions.settleAuction(activeAuction.auction_id)}>Settle auction</Button>}{marketActions.latestLedger < activeAuction.ends_at && !activeAuction.highest_bidder && <Button className="feed-market-action" variant="outline" onClick={() => marketActions.cancelAuction(activeAuction.auction_id)}>Cancel auction</Button>}</> : activeListing && activeListing.seller.toLowerCase() === marketActions.walletAddress.toLowerCase() ? <Button className="feed-market-action" variant="outline" onClick={() => marketActions.cancelListing(activeListing.listing_id, activeListing.contract_id)}>Cancel listing</Button> : <><Button className="feed-market-action" variant="outline" onClick={() => marketActions.sell(item)}>List</Button><Button className="feed-market-action" variant="quiet" onClick={() => marketActions.auction(item)}>Start auction</Button></>}{incomingOffer && <Button className="feed-market-action" onClick={() => marketActions.acceptOffer(incomingOffer.offer_id, incomingOffer.contract_id)}>Accept offer · {formatOfferXlm(incomingOffer.amount)} XLM</Button>}</> : <>{item.saleType !== 'Auction' && item.tokenId !== undefined && item.contractId && onOffer && <Button className="feed-market-action" variant="outline" onClick={onOffer}>Make offer</Button>}{item.saleType === 'Auction' && activeAuction && marketActions.latestLedger >= activeAuction.ends_at ? <Button className="feed-market-action" onClick={() => marketActions.settleAuction(activeAuction.auction_id)}>Settle auction</Button> : item.saleType === 'Auction' && onBuy ? <Button className="feed-market-action" onClick={() => marketActions.bid(item)}>Place bid · {item.price}</Button> : item.saleType === 'Buy now' && onBuy ? <Button className="feed-market-action" onClick={onBuy}>Buy · {item.price} <Icon name="arrow" size={13} /></Button> : null}</>}</span>
}

function SocialFeed({ posts, allNfts, walletAddress, onBuyMarketItem, onOfferMarketItem, ownedNfts, composeNft, setComposeNft, onMintNft, authorName, authorAvatar, allCollections, saved, onOpenArtwork, onSaveArtwork, onCollection, liked, disliked, comments, onLikeArtwork, onDislikeArtwork, onNftComment, feedPreferences, sharedPostId, postsLoadState, onRetryPosts, composeOpen, setComposeOpen, composeText, setComposeText, composeFile, setComposeFile, posting, onCreatePost, onPostLike, onPostDislike, onPostComment, onTipPost, onCreator }: { posts: PostRecord[]; allNfts: NFT[]; walletAddress: string; onBuyMarketItem: (item: NFT) => void; onOfferMarketItem: (item: NFT) => void; ownedNfts: NFT[]; composeNft: string; setComposeNft: (id: string) => void; onMintNft: () => void; authorName: string; authorAvatar: string; allCollections: Collection[]; saved: string[]; onOpenArtwork: (item: NFT) => void; onSaveArtwork: (id: string) => void; onCollection: (item: Collection) => void; liked: string[]; disliked: string[]; comments: Record<string, SocialComment[]>; onLikeArtwork: (id: string) => void; onDislikeArtwork: (id: string) => void; onNftComment: (id: string, text: string, parentId?: number | string | null) => Promise<void>; feedPreferences: FeedPreferences; sharedPostId: number; postsLoadState: 'loading' | 'ready' | 'error'; onRetryPosts: () => void; composeOpen: boolean; setComposeOpen: (v: boolean) => void; composeText: string; setComposeText: (v: string) => void; composeFile: File | null; setComposeFile: (v: File | null) => void; posting: boolean; onCreatePost: () => void | Promise<void>; onPostLike: (id: number) => void; onPostDislike: (id: number) => void; onPostComment: (id: number, text: string, parentId?: number | string | null) => Promise<void>; onTipPost: (id: number, recipient: string, amount: string, onProgress: (stage: 'preparing' | 'awaiting-wallet' | 'confirming') => void) => Promise<{ hash: string; amount: string; tipsCount?: number }>; onCreator: (creatorId: string) => void }) {
  const [sort, setSort] = useState<'latest' | 'popular'>('latest')
  const [sortOpen, setSortOpen] = useState(false)
  // Collection announcements belong on the Collections page; keep the home timeline for creator posts and NFT activity.
  const visiblePosts = posts.filter((post) => post.id === sharedPostId || (feedPreferences.creatorPosts && post.author_type !== 'collection'))
  const visibleNfts = sharedPostId || !feedPreferences.collectibles ? [] : allNfts
  const feedEntries = [
    ...visiblePosts.map((post) => ({ kind: 'post' as const, createdAt: post.created_at, post })),
    ...visibleNfts.map((item) => ({ kind: 'nft' as const, createdAt: item.createdAt ?? '', item })),
  ].sort((a, b) => sort === 'latest'
    ? (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
    : (b.kind === 'post' ? b.post.likes + b.post.comments.length : b.item.likes + b.item.comments) - (a.kind === 'post' ? a.post.likes + a.post.comments.length : a.item.likes + a.item.comments))
  return (
    <section className="section-block social-feed">
      <div className="section-title"><div><span className="eyebrow">YOUR TIMELINE</span><div className="feed-sort"><button type="button" className="feed-sort__trigger" aria-haspopup="listbox" aria-expanded={sortOpen} onClick={() => setSortOpen((open) => !open)}>{sort === 'latest' ? 'Latest' : 'Popular'}<Icon name="chevron" size={13} /></button>{sortOpen && <div className="feed-sort__menu" role="listbox" aria-label="Sort feed">{(['latest', 'popular'] as const).map((option) => <button type="button" role="option" aria-selected={sort === option} key={option} onClick={() => { setSort(option); setSortOpen(false) }}>{option === 'latest' ? 'Latest' : 'Popular'}</button>)}</div>}</div></div><Button variant="quiet" onClick={() => setComposeOpen(!composeOpen)}><Icon name="plus" size={15} /> {composeOpen ? 'Close' : 'Share art'} </Button></div>
      {composeOpen && <PostComposerModal onClose={() => setComposeOpen(false)} ownedNfts={ownedNfts} selectedNftId={composeNft} setSelectedNftId={setComposeNft} authorName={authorName} authorAvatar={authorAvatar} caption={composeText} setCaption={setComposeText} media={composeFile} setMedia={setComposeFile} posting={posting} onShare={onCreatePost} />}
      {feedEntries.map((entry) => entry.kind === 'post' ? <PostCard key={`post-${entry.post.id}`} post={entry.post} allNfts={allNfts} onLike={onPostLike} onDislike={onPostDislike} disliked={disliked.includes(`post:${entry.post.id}`)} onComment={onPostComment} onTipPost={onTipPost} onOpenNft={(nftId) => { const item = allNfts.find((nft) => nft.id === nftId); if (item) onOpenArtwork(item) }} onCreator={onCreator} onCollection={onCollection} collections={allCollections} walletAddress={walletAddress} onBuyNft={onBuyMarketItem} onOfferNft={onOfferMarketItem} /> : <FeedCollectibleCard key={`nft-${entry.item.id}`} item={entry.item} collection={allCollections.find((collection) => collection.id === entry.item.collectionId) ?? collectionFor(entry.item.collectionId)} saved={saved.includes(entry.item.id)} liked={liked.includes(entry.item.id)} disliked={disliked.includes(entry.item.id)} comments={comments[entry.item.id] ?? []} onSave={() => onSaveArtwork(entry.item.id)} onLike={() => onLikeArtwork(entry.item.id)} onDislike={() => onDislikeArtwork(entry.item.id)} onComment={(text) => onNftComment(entry.item.id, text)} onOpen={() => onOpenArtwork(entry.item)} onCollection={() => onCollection(allCollections.find((collection) => collection.id === entry.item.collectionId) ?? collectionFor(entry.item.collectionId))} />)}
      {!feedEntries.length && (postsLoadState === 'loading' ? <div className="empty-state empty-state--compact"><h3>Loading your feed…</h3><p>Checking art posts and collectibles.</p></div> : postsLoadState === 'error' ? <div className="empty-state empty-state--compact"><h3>Feed couldn’t load.</h3><p>The Testnet feed is temporarily unavailable. Try again in a moment.</p><Button variant="outline" onClick={onRetryPosts}>Try again</Button></div> : <div className="empty-state empty-state--compact"><h3>{feedPreferences.creatorPosts || feedPreferences.collectibles ? 'No posts yet.' : 'Your feed is hidden by Settings.'}</h3><p>{feedPreferences.creatorPosts || feedPreferences.collectibles ? 'Share art to start the conversation; collectibles can appear in the same feed.' : 'Turn on a content type in Settings to see it here.'}</p></div>)}
    </section>
  )
}

function CreateArtworkPreview({ file, src, title, emptyText = 'Your NFT will appear here' }: { file: File | null; src: string; title: string; emptyText?: string | null }) {
  const [localSrc, setLocalSrc] = useState('')
  useEffect(() => {
    if (!file) { setLocalSrc(''); return }
    const url = URL.createObjectURL(file)
    setLocalSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  if (file?.type.startsWith('video/') && localSrc) return <video className="create-modal__preview-media" src={localSrc} controls playsInline />
  const imageSrc = localSrc || (src ? mediaSource(src) : '')
  return imageSrc ? <img className="create-modal__preview-media" src={imageSrc} alt={title} /> : emptyText ? <div className="create-modal__preview-empty"><Icon name="image" size={34} /><span>{emptyText}</span></div> : null
}

function PostComposerModal({ onClose, ownedNfts, selectedNftId, setSelectedNftId, authorName, authorAvatar, caption, setCaption, media, setMedia, posting, onShare }: { onClose: () => void; ownedNfts: NFT[]; selectedNftId: string; setSelectedNftId: (id: string) => void; authorName: string; authorAvatar: string; caption: string; setCaption: (text: string) => void; media: File | null; setMedia: (file: File | null) => void; posting: boolean; onShare: () => void | Promise<void> }) {
  const selected = ownedNfts.find((item) => item.id === selectedNftId)
  const canShare = Boolean((selected || media || caption.trim()) && !posting)
  return <div className="modal-backdrop create-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="post-modal-title">
    <header className="create-modal__header"><button className="create-modal__back" onClick={onClose} aria-label="Back"><Icon name="arrow" size={23} /></button><h2 id="post-modal-title">Share artwork</h2><button className="create-modal__share" onClick={onShare} disabled={!canShare}>{posting ? 'Sharing…' : 'Share'}</button></header>
    <div className="create-modal__content">
      <div className="create-modal__preview"><CreateArtworkPreview file={media} src={selected?.image ?? ''} title={selected?.title ?? 'Post media'} emptyText={null} />{!media && !selected && <label className="create-modal__choose-media"><Icon name="image" size={24} /><span>Select photo or video</span><input type="file" accept="image/*,video/*" onChange={(event) => setMedia(event.target.files?.[0] ?? null)} /></label>}</div>
      <div className="create-modal__editor">
        <div className="create-modal__account"><Avatar src={authorAvatar} alt={authorName} size="sm" /><b>{authorName}</b></div>
        <textarea className="create-modal__caption" value={caption} maxLength={2000} onChange={(event) => setCaption(event.target.value)} placeholder="Add a caption…" aria-label="Post caption" />
        <div className="create-modal__caption-meta"><span aria-hidden="true">☺</span><small>{caption.length}/2,000</small></div>
        <div className="create-modal__section">
          <div className="create-modal__row-title"><span>Attach an NFT (optional)</span><Icon name="bookmark" size={18} /></div>
          {ownedNfts.length ? <select className="create-modal__select" value={selectedNftId} onChange={(event) => setSelectedNftId(event.target.value)} aria-label="Optionally attach an NFT you own"><option value="">Share without an NFT</option>{ownedNfts.map((item) => <option key={item.id} value={item.id}>{item.title} · {collectionFor(item.collectionId).name}</option>)}</select> : <small className="create-modal__optional-note">You can share artwork without minting it or owning an NFT.</small>}
          {selected && <div className="create-modal__selected-nft"><img src={mediaSource(selected.image)} alt="" /><span><b>{selected.title}</b><small>{collectionFor(selected.collectionId).name} · held in your wallet</small></span><Icon name="check" size={16} /></div>}
        </div>
        <label className="create-modal__section create-modal__media-row"><span>{media ? media.name : 'Add a photo or video'}</span><Icon name="image" size={19} /><input type="file" accept="image/*,video/*" onChange={(event) => setMedia(event.target.files?.[0] ?? null)} /></label>
        <div className="create-modal__tip">Share art first. You can attach one of your NFTs if it adds context; minting is optional.</div>
      </div>
    </div>
  </section></div>
}

function WalletDetailsModal({ wallet, onClose }: { wallet: StellarWallet; onClose: () => void }) {
  type WalletSnapshot = { balances: { asset_type: string; asset_code?: string; balance: string }[]; transactions: { hash: string; created_at: string; memo?: string; successful: boolean }[] }
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const loadWallet = async () => {
    setLoading(true)
    setError('')
    const horizon = wallet.network === 'PUBLIC' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org'
    try {
      const [accountResponse, transactionResponse] = await Promise.all([
        fetch(`${horizon}/accounts/${encodeURIComponent(wallet.address)}`),
        fetch(`${horizon}/accounts/${encodeURIComponent(wallet.address)}/transactions?order=desc&limit=8`),
      ])
      if (!accountResponse.ok) throw new Error(accountResponse.status === 404 ? 'This wallet has not been funded on this Stellar network yet.' : 'Could not load wallet balances.')
      if (!transactionResponse.ok) throw new Error('Could not load recent wallet transactions.')
      const [accountData, transactionData] = await Promise.all([accountResponse.json(), transactionResponse.json()])
      setSnapshot({ balances: accountData.balances ?? [], transactions: transactionData?._embedded?.records ?? [] })
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Could not load wallet details.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void loadWallet() }, [wallet.address, wallet.network])
  return <div className="modal-backdrop wallet-details-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="wallet-modal wallet-details-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-details-title" aria-busy={loading}>
    <button className="modal-close" type="button" onClick={onClose} aria-label="Close wallet details"><Icon name="close" size={18} /></button>
    <span className="eyebrow">{wallet.network === 'PUBLIC' ? 'STELLAR MAINNET' : 'STELLAR TESTNET'}</span>
    <h2 id="wallet-details-title">Wallet</h2>
    <p className="wallet-details-address">{shortenStellarAddress(wallet.address)}</p>
    <div className="wallet-details-toolbar"><strong>Balances & recent activity</strong><Button variant="outline" onClick={() => void loadWallet()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</Button></div>
    {loading && !snapshot ? <p className="muted-note">Loading your wallet…</p> : error ? <p className="wallet-overview__error" role="status">{error}</p> : snapshot && <><div className="wallet-balances">{snapshot.balances.map((balance, index) => <div className="wallet-balance" key={`${balance.asset_type}-${balance.asset_code ?? 'native'}-${index}`}><small>{balance.asset_type === 'native' ? 'XLM' : balance.asset_code || 'Asset'}</small><b>{Number(balance.balance).toLocaleString(undefined, { maximumFractionDigits: 7 })}</b></div>)}</div><div className="wallet-transactions"><strong>Recent transactions</strong>{snapshot.transactions.length ? snapshot.transactions.map((transaction) => <a key={transaction.hash} href={`${STELLAR_EXPLORER_URL}/tx/${transaction.hash}`} target="_blank" rel="noreferrer"><span><b>{transaction.memo?.trim() || (transaction.successful ? 'Confirmed transaction' : 'Failed transaction')}</b><small>{new Date(transaction.created_at).toLocaleString()}</small></span><code>{shortenStellarAddress(transaction.hash)}</code><Icon name="arrow" size={14} /></a>) : <p>No transactions yet.</p>}</div></>}
    <a className="wallet-details-explorer" href={`${STELLAR_EXPLORER_URL}/account/${wallet.address}`} target="_blank" rel="noreferrer">Open wallet in Stellar Expert <Icon name="arrow" size={14} /></a>
  </section></div>
}

function WalletModal({ item, mode, auction, wallet, emailSignIn, emailReady, onClose, onConnect, onConnectFreighter, onPurchase, actionStatus, actionError }: { item: NFT | null; mode: WalletMode; auction: MarketplaceAuction | null; wallet: StellarWallet | null; emailSignIn: boolean; emailReady: boolean; onClose: () => void; onConnect: () => void | Promise<void>; onConnectFreighter: () => void | Promise<void>; onPurchase: (amount?: string, durationHours?: string, minIncrement?: string, paymentToken?: string) => void; actionStatus: WalletActionStatus; actionError: string }) {
  const [paymentToken, setPaymentToken] = useState(auction?.payment_token ?? sorobanMarketplaceConfig.paymentToken ?? stellarPaymentAssets[0].contractId)
  const selectedAsset = stellarPaymentAssets.find((asset) => asset.contractId === (mode === 'bid' && auction ? auction.payment_token : paymentToken)) ?? stellarPaymentAssets[0]
  const [amount, setAmount] = useState(mode === 'bid' && auction ? formatTokenAmount((BigInt(auction.highest_bid || '0') + BigInt(auction.min_increment || '0')).toString(), selectedAsset.decimals) : item?.bestOffer?.replace(' XLM', '') ?? '1')
  const [durationHours, setDurationHours] = useState('24')
  const [minimumIncrement, setMinimumIncrement] = useState('0.01')
  const ready = Boolean(wallet)
  const busy = ['preparing', 'awaiting-wallet', 'confirming'].includes(actionStatus)
  const complete = actionStatus === 'complete'
  const title = complete ? (mode === 'buy' ? 'NFT purchased' : mode === 'sell' ? 'NFT listed' : mode === 'auction' ? 'Auction started' : mode === 'bid' ? 'Bid placed' : 'Offer placed') : !item ? 'Connect your Stellar wallet' : mode === 'offer' ? 'Make an offer' : mode === 'sell' ? 'List your NFT' : mode === 'auction' ? 'Start an auction' : mode === 'bid' ? 'Place a bid' : 'Purchase NFT'
  const progressMessage = actionStatus === 'preparing'
    ? mode === 'buy' ? 'Preparing your purchase transaction…' : mode === 'sell' ? 'Preparing your listing…' : mode === 'auction' ? 'Preparing the auction…' : mode === 'bid' ? 'Preparing your bid…' : 'Preparing your offer transaction…'
    : actionStatus === 'awaiting-wallet'
      ? mode === 'buy' ? 'Approve the purchase in your wallet to continue.' : mode === 'sell' ? 'Approve the transaction in your wallet to continue listing.' : mode === 'auction' ? 'Approve the NFT transfer and auction in your wallet.' : mode === 'bid' ? 'Approve the bid in your wallet.' : 'Approve the offer in your wallet to continue.'
      : actionStatus === 'confirming'
        ? mode === 'buy' ? 'Purchase submitted. Waiting for Stellar to confirm it…' : mode === 'sell' ? 'Transaction submitted. Waiting for Stellar to confirm your listing…' : mode === 'auction' ? 'Auction submitted. Waiting for Stellar to confirm it…' : mode === 'bid' ? 'Bid submitted. Waiting for Stellar to confirm it…' : 'Offer submitted. Waiting for Stellar to confirm it…'
        : ''
  const closeWhenSafe = () => { if (!busy) onClose() }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenSafe()}>
    <div className="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title" aria-busy={busy}>
      <button className="modal-close" onClick={closeWhenSafe} aria-label="Close" disabled={busy}><Icon name="close" size={18} /></button>
      <div className={`wallet-modal__icon ${complete ? 'wallet-modal__icon--success' : ''}`}><Icon name={complete ? 'check' : ready ? 'check' : 'wallet'} size={24} /></div>
      <span className="eyebrow">STELLAR WALLET</span>
      <h2 id="wallet-title">{title}{item ? <> · <i>{item.title}</i></> : null}</h2>
      {complete ? <div className="offer-result" role="status" aria-live="polite">
        <strong>{mode === 'buy' ? 'Purchase confirmed' : mode === 'sell' ? 'Your listing is live' : mode === 'auction' ? 'Your auction is live' : mode === 'bid' ? 'Your bid is active' : 'Your offer is active'}</strong>
        <p>{mode === 'buy' ? `${item?.title} is now yours on Stellar ${wallet?.network === 'PUBLIC' ? 'Mainnet' : 'Testnet'}. It will appear in your portfolio as ownership indexing completes.` : mode === 'sell' ? `${item?.title} is now listed on Stellar ${wallet?.network === 'PUBLIC' ? 'Mainnet' : 'Testnet'}. You can manage it from your account.` : mode === 'auction' ? `${item?.title} is in an on-chain auction for ${durationHours} hours. Bids are escrowed and outbid funds are refunded automatically.` : mode === 'bid' ? `Your ${amount} XLM bid for ${item?.title} is held in escrow. If outbid, the previous bid is refunded.` : `Stellar ${wallet?.network === 'PUBLIC' ? 'Mainnet' : 'Testnet'} confirmed your offer for ${item?.title}. You can review or cancel it from Account → Offers.`}</p>
        <Button onClick={onClose}>Done <Icon name="check" size={15} /></Button>
      </div> : ready ? <div className="purchase-intent">
        <div><small>{mode === 'sell' ? `List price (${selectedAsset.code})` : mode === 'offer' ? `Offer amount (${selectedAsset.code})` : mode === 'auction' ? `Reserve price (${selectedAsset.code})` : mode === 'bid' ? `Your bid${auction ? ` · current ${formatTokenAmount(auction.highest_bid, selectedAsset.decimals)} ${selectedAsset.code}` : ''}` : 'Purchase price'}</small>{mode === 'buy' ? <b>{item?.price ?? 'Listing price unavailable'}</b> : <input className="offer-input" type="number" min="0.0000001" step={10 ** -selectedAsset.decimals} value={amount} disabled={busy} onChange={(event) => setAmount(event.target.value)} aria-label={`Amount in ${selectedAsset.code}`} />}{['sell', 'offer', 'auction'].includes(mode) && stellarPaymentAssets.length > 1 && <label className="create-modal__field"><span>Payment currency</span><select className="offer-input" value={paymentToken} disabled={busy} onChange={(event) => setPaymentToken(event.target.value)}>{stellarPaymentAssets.map((asset) => <option key={asset.contractId} value={asset.contractId}>{asset.code}</option>)}</select></label>}{mode === 'auction' && <><label className="create-modal__field"><span>Minimum bid increment ({selectedAsset.code})</span><input className="offer-input" type="number" min="0" step={10 ** -selectedAsset.decimals} value={minimumIncrement} disabled={busy} onChange={(event) => setMinimumIncrement(event.target.value)} /></label><label className="create-modal__field"><span>Auction duration (hours)</span><input className="offer-input" type="number" min="1" max="720" step="1" value={durationHours} disabled={busy} onChange={(event) => setDurationHours(event.target.value)} /></label></>}<em>{wallet?.network === 'PUBLIC' ? 'Stellar Mainnet' : 'Stellar Testnet'}</em></div>
        {mode === 'buy' ? <Button onClick={() => onPurchase()} disabled={busy}>{busy ? 'Confirming purchase…' : <>Buy NFT <Icon name="arrow" size={15} /></>}</Button> : <Button onClick={() => onPurchase(amount, durationHours, minimumIncrement, paymentToken)} disabled={busy}>{busy ? <><span className="offer-progress-spinner" aria-hidden="true" />{actionStatus === 'preparing' ? 'Preparing…' : actionStatus === 'awaiting-wallet' ? 'Approve in wallet…' : 'Confirming on Stellar…'}</> : mode === 'sell' ? 'List NFT for sale' : mode === 'auction' ? 'Start auction' : mode === 'bid' ? 'Place bid' : 'Submit offer'}{!busy && <Icon name="arrow" size={15} />}</Button>}

        {progressMessage && <p className="offer-progress" role="status" aria-live="polite"><span className="offer-progress-spinner" aria-hidden="true" />{progressMessage}</p>}
        {actionStatus === 'error' && actionError && <p className="offer-progress offer-progress--error" role="alert">{actionError}</p>}
      </div> : <div className="connect-stack"><p>{emailSignIn ? 'Sign up or sign in with your email. StellaNova will create your Stellar wallet automatically.' : 'Connect a Stellar wallet to get started.'}</p>{emailSignIn && <Button onClick={onConnect} disabled={!emailReady}>{emailReady ? <>Continue with email <Icon name="arrow" size={15} /></> : 'Loading email sign-in…'}</Button>}<Button variant={emailSignIn ? 'outline' : 'primary'} onClick={onConnectFreighter}>{emailSignIn ? 'I already have Freighter' : 'Connect Freighter'} <Icon name="arrow" size={15} /></Button></div>}
      {!complete && <small className="wallet-footnote">Your email identifies your account; it is never used as your wallet key.</small>}
    </div>
  </div>
}
function mintKindLabel(kind: string): string {
  switch (kind) {
    case 'team': return 'Team mint'
    case 'guaranteed': return 'Guaranteed mint'
    case 'fcfs': return 'FCFS mint'
    case 'public': return 'Public mint'
    default: return 'Mint'
  }
}

function parseTraits(raw: string): { trait_type: string; value: string }[] {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (rows.length > 100) throw new Error('NFT metadata supports up to 100 traits')
  return rows.map((line) => {
    const split = line.indexOf(':')
    if (split <= 0 || split === line.length - 1) throw new Error(`Trait must use "name: value" format: ${line}`)
    return { trait_type: line.slice(0, split).trim(), value: line.slice(split + 1).trim() }
  })
}

function parseEditionTraits(raw: string, editionIndex: number): { trait_type: string; value: string }[] {
  const selected = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const edition = line.match(/^#(\d+)\s+(.+)$/)
    if (!edition) return [line]
    return Number(edition[1]) === editionIndex + 1 ? [edition[2]] : []
  })
  return parseTraits(selected.join('\n'))
}

function mintXlm(price: string | null | undefined): string {
  if (price === null || price === undefined || price === '') return 'Free'
  return `${Number(price).toFixed(2)} XLM`
}

function xlmToStroops(value: string): bigint {
  const input = value.trim() || '0'
  if (!/^\d+(?:\.\d{1,7})?$/.test(input)) throw new Error('Enter a price with no more than 7 decimal places')
  const [whole, fraction = ''] = input.split('.')
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
}

function mintWindow(start: string | null, end: string | null): string {
  const fmt = (iso: string | null) => {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return `${d.toLocaleString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} UTC`
  }
  return `${fmt(start)} → ${fmt(end)}`
}

function formatMintCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
  return days ? `${days}d ${clock}` : clock
}

type DropArtworkUpload = { file: File; animation?: File; name?: string; description?: string; attributes?: { trait_type: string; value: string | number | boolean }[]; rarityScore?: number }

function CollectionDropSetup({ collection, wallet, onClose, onLaunched, notify }: { collection: Collection; wallet: StellarWallet | null; onClose: () => void; onLaunched: () => void; notify: (message: string) => void }) {
  const slug = collection.id
  const [draft, setDraft] = useState<CollectionDropDraft>({ startTime: '', artwork: [], stages: [], allowlists: {}, rarityMix: { high: 10, medium: 30, common: 60 }, masterArtworkExpansion: false, stageIds: {} })
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [files, setFiles] = useState<DropArtworkUpload[]>([])
  const [artworkDescription, setArtworkDescription] = useState('')
  const [kind, setKind] = useState<MintStage['kind']>('team')
  const [stageName, setStageName] = useState('')
  const [duration, setDuration] = useState('24')
  const [stagePrice, setStagePrice] = useState('0')
  const [walletLimit, setWalletLimit] = useState('1')
  const [stageSupply, setStageSupply] = useState('')
  const [selectedArt, setSelectedArt] = useState<string[]>([])
  const [allowlistStage, setAllowlistStage] = useState('')
  const [addressBatch, setAddressBatch] = useState('')

  useEffect(() => {
    if (!wallet) { setLoading(false); return }
    void Promise.all([fetchCollectionDropDraft(wallet.address, slug), loadStudioDraft<TransferAsset[]>(`ai-collection-transfer:${slug}`)]).then(([saved, queued]) => {
      setDraft(saved)
      if (queued?.length) {
        setFiles(queued.map((asset) => ({ file: new File([asset.file], asset.name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120) + (asset.file.type === 'image/jpeg' ? '.jpg' : '.png'), { type: asset.file.type || 'image/png' }), animation: asset.animation ? new File([asset.animation], asset.name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120) + '.gif', { type: 'image/gif' }) : undefined, name: asset.name, description: asset.description, attributes: asset.attributes, rarityScore: asset.rarityScore })))
        setMessage(`${queued.length} reviewed AI artwork${queued.length === 1 ? '' : 's'} ready to upload. Save artwork to add it to this collection.`)
      }
      setLoading(false)
    }).catch((error) => { setMessage(error instanceof Error ? error.message : 'Could not load saved setup'); setLoading(false) })
  }, [slug, wallet?.address])

  const save = async (next: CollectionDropDraft, success?: string) => {
    if (!wallet) throw new Error('Connect the collection owner wallet to save setup')
    await saveCollectionDropDraft(wallet.address, slug, next)
    setDraft(next)
    if (success) { setMessage(success); notify(success) }
  }

  const saveArtwork = async () => {
    if (!wallet || !files.length) { setMessage('Choose artwork to upload first'); return }
    if (files.length + draft.artwork.length > 10000) { setMessage('A collection can have up to 10,000 artwork editions'); return }
    setBusy(true); setMessage('Uploading and saving artwork…')
    try {
      const uploaded: CollectionDropDraft['artwork'] = []
      for (const queued of files) {
        const file = queued.file
        const media = await uploadMedia(file, slug, { walletAddress: wallet.address })
        const image = media.original.r2Url ?? media.original.cloudinaryUrl
        if (!image) throw new Error(`Could not upload ${file.name}`)
        const animationMedia = queued.animation ? await uploadMedia(queued.animation, slug, { walletAddress: wallet.address }) : null
        const animationUrl = animationMedia?.original.r2Url ?? animationMedia?.original.cloudinaryUrl ?? undefined
        const name = queued.name?.trim().slice(0, 140) || file.name.replace(/\.[^.]+$/, '').slice(0, 140) || `Artwork ${draft.artwork.length + uploaded.length + 1}`
        uploaded.push({ id: crypto.randomUUID(), name, image, animation_url: animationUrl, description: queued.description?.trim() || artworkDescription.trim(), attributes: queued.attributes ?? [] })
      }
      await save({ ...draft, artwork: [...draft.artwork, ...uploaded] }, `${uploaded.length} artwork file${uploaded.length === 1 ? '' : 's'} saved`)
      await deleteStudioDraft(`ai-collection-transfer:${slug}`).catch(() => {})
      setFiles([]); setArtworkDescription('')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save artwork') }
    finally { setBusy(false) }
  }

  const saveArtworkDetails = async (artworkId: string) => {
    const artwork = draft.artwork.find((item) => item.id === artworkId)
    if (!artwork) return
    const stages = draft.stages.map((stage) => stage.artworkIds.includes(artworkId) ? { ...stage, metadataUris: [], editionGroup: undefined } : stage)
    try {
      await save({ ...draft, stages }, `${artwork.name || 'Artwork'} details saved`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save artwork details')
    }
  }

  const saveStart = async () => {
    const start = new Date(draft.startTime)
    if (!draft.startTime || Number.isNaN(start.getTime())) { setMessage('Choose the mint start date and time'); return }
    try { await save({ ...draft, startTime: start.toISOString() }, 'Mint start date saved') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save the mint start date') }
  }

  const addStageDraft = async () => {
    if (!draft.startTime) { setMessage('Save the mint start date first'); setStep(1); return }
    const assets = draft.artwork.filter((item) => selectedArt.includes(item.id))
    if (!assets.length) { setMessage('Choose the artwork for this stage'); return }
    const hours = Number(duration); const limit = Number(walletLimit); const supply = Number(stageSupply)
    if (!Number.isInteger(hours) || hours < 1 || hours > 8760) { setMessage('Stage duration must be between 1 hour and 365 days'); return }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) { setMessage('Per-wallet limit must be a whole number from 1 to 1,000'); return }
    if (!Number.isSafeInteger(supply) || supply < 1 || supply > 1_000_000) {
      setMessage('Enter a stage allocation between 1 and 1,000,000 NFTs.')
      return
    }
    const collectionSupply = Number(collection.totalSupply ?? 0)
    const alreadyAllocated = draft.stages.reduce((total, stage) => total + (stage.maxSupply ?? 0), 0)
    if (collectionSupply > 0 && alreadyAllocated + supply > collectionSupply) {
      setMessage(`This stage exceeds the ${collectionSupply.toLocaleString()} NFT collection supply. ${Math.max(0, collectionSupply - alreadyAllocated).toLocaleString()} remain to allocate.`)
      return
    }
    try { xlmToStroops(stagePrice) } catch (error) { setMessage(error instanceof Error ? error.message : 'Enter a valid XLM price'); return }
    if (draft.stages.some((item) => item.kind === 'public')) { setMessage('The public stage is final. Remove it before adding another presale stage.'); return }
    if (kind !== 'public' && draft.stages.filter((item) => item.kind !== 'public').length >= 5) { setMessage('A drop can have up to 5 presale stages'); return }
    const nextStage: CollectionDropDraftStage = { key: crypto.randomUUID(), kind, name: stageName.trim() || mintKindLabel(kind), durationHours: hours, price: stagePrice.trim() || '0', perWalletLimit: limit, maxSupply: supply, artworkIds: assets.map((item) => item.id) }
    const next = { ...draft, stages: [...draft.stages, nextStage] }
    try { await save(next, `${mintKindLabel(kind)} stage saved`); setStageName(''); setSelectedArt([]); setStageSupply('') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save this stage') }
  }

  const removeStageDraft = async (key: string) => {
    const next = { ...draft, stages: draft.stages.filter((stage) => stage.key !== key), allowlists: Object.fromEntries(Object.entries(draft.allowlists).filter(([stageKey]) => stageKey !== key)) }
    try { await save(next, 'Stage removed from the draft') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not remove this stage') }
  }

  const clearSavedSetup = async () => {
    if (!wallet) { setMessage('Connect the collection owner wallet to clear this setup'); return }
    if (draft.launched) { setMessage('This drop is already launched and cannot be cleared as a draft'); return }
    if (!window.confirm('Clear all saved artwork, dates, stage settings, and allowlists for this collection setup? Any unpublished stages will also be removed from Stellar Testnet.')) return
    setBusy(true)
    setMessage('Checking and removing unpublished stages…')
    try {
      const plan = await fetchCollectionDropResetPlan(wallet.address, slug)
      if (plan.stageIds.length) {
        const contractId = (await fetchCollectionDrop(slug, wallet.address)).collection.contractId
        if (!contractId) throw new Error('This collection has no registered NFT contract')
        // Stage IDs belong to the contract that created them. Try that saved
        // contract first, then registered Testnet contracts for pre-migration drafts.
        const candidates = [...new Set([draft.stageContractId, contractId, ...plan.candidateContractIds].filter((id): id is string => Boolean(id)))]
        for (const stageId of plan.stageIds) {
          for (const candidate of candidates) {
            try { await removeCreatorStage(wallet, candidate, stageId); break }
            catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              if (!detail.includes('UnreachableCodeReached')) throw error
            }
          }
          // The ID may belong to a contract that has since been retired or may
          // have failed before reaching chain; in either case there is no stage to remove.
        }
      }
      await clearCollectionDropDraft(wallet.address, slug, plan.stageIds)
      setDraft({ startTime: '', artwork: [], stages: [], allowlists: {}, stageIds: {} })
      setFiles([]); setArtworkDescription(''); setKind('team'); setStageName(''); setDuration('24'); setStagePrice('0'); setWalletLimit('1'); setStageSupply(''); setSelectedArt([]); setAllowlistStage(''); setAddressBatch('')
      setStep(0)
      setMessage('Saved setup cleared. You can start again.')
      notify('Saved collection setup cleared')
    } catch (error) {
      setMessage(error instanceof Error ? `Could not clear the setup: ${error.message}` : 'Could not clear the setup')
    } finally { setBusy(false) }
  }

  const saveAddressBatch = async () => {
    if (!allowlistStage) { setMessage('Choose a presale stage'); return }
    const rows = addressBatch.split(/[\n;]+/).map((line) => line.trim()).filter(Boolean).map((line) => line.split(',').map((part) => part.trim()))
    if (!rows.length) { setMessage('Paste wallet addresses to whitelist'); return }
    if (rows.some((row) => !/^G[A-Z2-7]{55}$/.test(row[0] ?? ''))) { setMessage('Every entry needs a valid Stellar G-address'); return }
    const entries = rows.map(([address, limit, price]) => ({ wallet: address, customLimit: limit ? Number(limit) : null, customPrice: price || null }))
    if (entries.some((entry) => entry.customLimit !== null && (!Number.isInteger(entry.customLimit) || entry.customLimit < 1 || entry.customLimit > 1000) || entry.customPrice !== null && !/^\d+(?:\.\d{1,7})?$/.test(entry.customPrice))) { setMessage('Check the optional per-wallet limit or price in your list'); return }
    const current = draft.allowlists[allowlistStage] ?? []
    const merged = [...current]
    for (const entry of entries) { const index = merged.findIndex((saved) => saved.wallet === entry.wallet); if (index >= 0) merged[index] = entry; else merged.push(entry) }
    try { await save({ ...draft, allowlists: { ...draft.allowlists, [allowlistStage]: merged } }, `${entries.length} address${entries.length === 1 ? '' : 'es'} saved to this stage`); setAddressBatch('') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save these addresses') }
  }

  const launch = async () => {
    if (!wallet) { setMessage('Connect the collection owner wallet to launch'); return }
    if (!draft.startTime || !draft.artwork.length || !draft.stages.length) { setMessage('Save artwork, a mint date, and at least one mint stage before launch'); return }
    const currentDrop = await fetchCollectionDrop(slug, wallet.address)
    const contractId = currentDrop.collection.contractId
    if (!contractId) { setMessage('This collection has no registered NFT contract'); return }
    if (!currentDrop.collection.revealed && !currentDrop.collection.placeholderMetadataUri) {
      setMessage('Set a placeholder and hide the collection before launching unrevealed mint stages')
      return
    }
    setBusy(true); setMessage('Publishing your drop to Stellar Testnet… approve each wallet transaction when prompted.')
    try {
      const masterArtworkExpansion = draft.masterArtworkExpansion === true
      const fullSupply = Number(collection.totalSupply ?? draft.stages.reduce((sum, stage) => sum + (stage.maxSupply ?? 0), 0))
      if (!Number.isSafeInteger(fullSupply) || fullSupply < 1 || (masterArtworkExpansion && fullSupply > 10000)) throw new Error(masterArtworkExpansion ? 'This studio currently supports up to 10,000 editions with individual rarity metadata.' : 'The collection supply is invalid.')
      const rarityMix = draft.rarityMix ?? { high: 10, medium: 30, common: 60 }
      if (masterArtworkExpansion && rarityMix.high + rarityMix.medium + rarityMix.common !== 100) throw new Error('High, medium, and common rarity percentages must total 100% in the collection studio.')
      const raritySeed = draft.raritySeed ?? [...slug].reduce((seed, character) => Math.imul(seed ^ character.charCodeAt(0), 16777619), 2166136261) >>> 0
      const raritySchedule = masterArtworkExpansion ? getRarityTierSchedule(fullSupply, rarityMix, raritySeed) : []
      let cursor = new Date(draft.startTime).getTime()
      const stageIds = { ...(draft.stageIds ?? {}) }
      let launchDraft = { ...draft, raritySeed, stageContractId: draft.stageContractId ?? contractId }
      let editionOffset = 0
      for (const stage of launchDraft.stages) {
        const sortOrder = draft.stages.findIndex((item) => item.key === stage.key)
        if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error(`Could not determine the order for ${stage.name}; reload the saved drop and try again`)
        const assets = stage.artworkIds.map((id) => draft.artwork.find((art) => art.id === id)).filter((art): art is CollectionDropDraft['artwork'][number] => Boolean(art))
        if (!assets.length) throw new Error(`Choose artwork for ${stage.name} before launch`)
        const editionSupply = stage.maxSupply ?? Math.max(0, fullSupply - editionOffset)
        if (!Number.isSafeInteger(editionSupply) || editionSupply < 1 || editionOffset + editionSupply > fullSupply) throw new Error(`${stage.name} exceeds the ${fullSupply.toLocaleString()} collection supply`)
        const editionTiers: RarityTier[] = masterArtworkExpansion ? raritySchedule.slice(editionOffset, editionOffset + editionSupply) : []
        if (masterArtworkExpansion && editionTiers.length !== editionSupply) throw new Error(`Could not allocate rarity tiers for ${stage.name}`)
        editionOffset += editionSupply
        let editionPlan: { asset: CollectionDropDraft['artwork'][number]; tier: RarityTier | null }[]
        if (masterArtworkExpansion) {
          const rankedAssets = [...assets].sort((left, right) => Number(right.rarityScore ?? 0) - Number(left.rarityScore ?? 0))
          const masterTierCounts = getRarityTierCounts(rankedAssets.length, rarityMix)
          const masterGroups: Record<'high' | 'medium' | 'common', CollectionDropDraft['artwork']> = {
            high: rankedAssets.slice(0, masterTierCounts.high),
            medium: rankedAssets.slice(masterTierCounts.high, masterTierCounts.high + masterTierCounts.medium),
            common: rankedAssets.slice(masterTierCounts.high + masterTierCounts.medium),
          }
          const fallbackMaster = { high: rankedAssets[0], medium: rankedAssets[Math.floor((rankedAssets.length - 1) / 2)], common: rankedAssets[rankedAssets.length - 1] }
          const stageSeed = [...stage.key].reduce((seed, character) => Math.imul(seed ^ character.charCodeAt(0), 16777619), raritySeed) >>> 0
          for (const tier of ['high', 'medium', 'common'] as const) {
            masterGroups[tier] = seededShuffle(masterGroups[tier], stageSeed ^ (tier === 'high' ? 0x13579bdf : tier === 'medium' ? 0x2468ace0 : 0x10293847))
            if (!masterGroups[tier].length) masterGroups[tier] = [fallbackMaster[tier]]
          }
          const tierOffsets = { high: 0, medium: 0, common: 0 }
          editionPlan = editionTiers.map((tier) => {
            const group = masterGroups[tier]
            const asset = group[tierOffsets[tier]++ % group.length]
            return { asset, tier }
          })
        } else {
          editionPlan = assets.map((asset) => ({ asset, tier: null }))
        }
        const savedStageId = stageIds[stage.key]
        const start = new Date(cursor)
        const end = new Date(cursor + stage.durationHours * 60 * 60 * 1000)
        let currentStage = launchDraft.stages.find((item) => item.key === stage.key)!
        let editionGroup = currentStage.editionGroup
        let metadataUris = currentStage.metadataUris ?? []
        const editionMetadataCount = masterArtworkExpansion ? editionSupply : assets.length
        if (masterArtworkExpansion && !editionGroup && metadataUris.length) metadataUris = []
        if (metadataUris.length > editionMetadataCount) { editionGroup = undefined; metadataUris = [] }
        if (metadataUris.length !== editionMetadataCount && !editionGroup) editionGroup = crypto.randomUUID()
        const saveEditionProgress = async () => {
          const savedStages = launchDraft.stages.map((item) => item.key === stage.key ? { ...item, editionGroup, metadataUris } : item)
          launchDraft = { ...launchDraft, stages: savedStages }
          setDraft(launchDraft)
          await saveCollectionDropDraft(wallet.address, slug, launchDraft)
          if (savedStageId) await updateMintStageMetadata(wallet.address, slug, savedStageId, metadataUris)
        }
        if (metadataUris.length !== editionMetadataCount && !currentStage.editionGroup) await saveEditionProgress()
        if (metadataUris.length !== editionMetadataCount) {
          for (let offset = metadataUris.length; offset < editionMetadataCount; offset += 8) {
            const batch = editionPlan.slice(offset, Math.min(offset + 8, editionMetadataCount))
            setMessage(`Preparing edition metadata ${Math.min(offset + batch.length, editionMetadataCount)} of ${editionMetadataCount} for ${stage.name}…`)
            const uploaded = await Promise.all(batch.map(async ({ asset, tier }, batchIndex) => {
              const index = offset + batchIndex
              const cleanName = asset.name.replace(/\s+#\d+$/i, '').trim() || collection.name
              const attributes: { trait_type: string; value: string | number | boolean }[] = [...(asset.attributes ?? []).filter((attribute: { trait_type: string; value: string | number | boolean }) => String(attribute.trait_type).toLowerCase() !== 'rarity')]
              if (tier) attributes.push({ trait_type: 'Rarity', value: tier === 'high' ? 'High' : tier === 'medium' ? 'Medium' : 'Common' })
              const name = masterArtworkExpansion ? `${cleanName} #${index + 1}` : assets.length > 1 ? `${asset.name} #${index + 1}` : asset.name
              const metadata = await uploadCreatorMetadata(wallet.address, slug, { name, description: asset.description, image: asset.image, animation_url: asset.animation_url || undefined, attributes, creation_method: 'ai-collection-studio', ...(editionGroup ? { edition_group: editionGroup, edition_index: index } : {}) })
              if (!metadata.url) throw new Error(`Could not prepare edition ${index + 1} metadata`)
              return metadata.url
            }))
            metadataUris = [...metadataUris, ...uploaded]
            await saveEditionProgress()
          }
        }
        let stageId = savedStageId
        if (!stageId) {
          const created = await createMintStage(wallet.address, slug, { kind: stage.kind, name: stage.name, startTime: start.toISOString(), endTime: end.toISOString(), price: Number(stage.price), perWalletLimit: stage.perWalletLimit, maxSupply: editionSupply, metadataUris, draft: true })
          stageId = created.id
          stageIds[stage.key] = stageId
          launchDraft = { ...launchDraft, stageIds: { ...stageIds } }
          await save(launchDraft)
        }
        const editionCount = masterArtworkExpansion ? editionSupply : assets.length
        await setCreatorStage(wallet, contractId, { stageId, kind: stage.kind, startTime: Math.floor(start.getTime() / 1000), endTime: Math.floor(end.getTime() / 1000), priceStroops: xlmToStroops(stage.price), perWalletLimit: stage.perWalletLimit, maxSupply: editionSupply, sortOrder, collectionSlug: slug, metadataUri: !currentDrop.collection.revealed ? currentDrop.collection.placeholderMetadataUri! : editionCount > 1 ? metadataUris[0].replace(/0\.json$/, '') : metadataUris[0], editionCount })
        const entries = launchDraft.allowlists[stage.key] ?? []
        for (let offset = 0; offset < entries.length; offset += 10) {
          const batch = entries.slice(offset, offset + 10).map((entry) => ({ wallet: entry.wallet, customLimit: entry.customLimit, customPriceStroops: entry.customPrice === null ? null : xlmToStroops(entry.customPrice) }))
          await whitelistCreatorWalletBatch(wallet, contractId, stageId, batch)
        }
        if (entries.length) await addWhitelistEntries(wallet.address, slug, stageId, entries.map((entry) => ({ ...entry, customPrice: entry.customPrice === null ? null : Number(entry.customPrice) })))
        await publishMintStage(wallet.address, slug, stageId)
        cursor = end.getTime()
      }
      await save({ ...launchDraft, stageIds, launched: true }, 'Drop stages confirmed on Stellar Testnet and published on the collection page')
      try {
        const startLabel = new Date(draft.startTime).toLocaleString()
        await createPost(wallet.address, { collectionId: slug, caption: `${collection.name} mint is scheduled to start ${startLabel}. View the collection for stages, prices, artwork and mint access.` })
        window.dispatchEvent(new Event('nftgram:refresh-feed'))
        window.dispatchEvent(new CustomEvent('nftgram:refresh-collection', { detail: { collectionId: slug } }))
      } catch { notify('Drop launched, but the feed announcement could not be posted') }
      onLaunched(); onClose()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Launch did not finish. Resume to continue publishing the saved setup.') }
    finally { setBusy(false) }
  }

  const dateValue = draft.startTime ? new Date(new Date(draft.startTime).getTime() - new Date(draft.startTime).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
  const presales = draft.stages.filter((stage) => stage.kind !== 'public')
  let previewCursor = draft.startTime ? new Date(draft.startTime).getTime() : 0
  const previewStages = draft.stages.map((stage) => {
    const start = previewCursor
    const end = start + stage.durationHours * 60 * 60 * 1000
    previewCursor = end
    return { stage, start, end }
  })
  const rarityMix = draft.rarityMix ?? { high: 10, medium: 30, common: 60 }
  const rarityCounts = getRarityTierCounts(Number(collection.totalSupply ?? 0), rarityMix)
  const steps = ['Artwork', 'Start date', 'Stages', 'Whitelist', 'Preview & launch']
  return <div className="drop-wizard" role="dialog" aria-modal="true" aria-labelledby="drop-wizard-title">
    <div className="drop-wizard__top"><div><span className="eyebrow">COLLECTION SETUP</span><h2 id="drop-wizard-title">Set up your mint</h2></div><button className="drop-wizard__close" onClick={onClose} aria-label="Close setup" disabled={busy}>×</button></div>
    <nav className="drop-wizard__steps" aria-label="Drop setup steps">{steps.map((label, index) => <button key={label} className={step === index ? 'is-active' : step > index ? 'is-done' : ''} onClick={() => setStep(index)}><b>{index + 1}</b><span>{label}</span></button>)}</nav>
    {loading ? <p className="drop-wizard__message">Loading saved setup…</p> : <div className="drop-wizard__body">
      {step === 0 && <div className="drop-wizard__panel"><h3>1. Add the artwork</h3><p>{draft.masterArtworkExpansion ? "The studio creates up to 8 unique master artworks. They are reused across the collection's full supply, while launch creates unique metadata for each NFT and applies the rarity mix: " + rarityMix.high + "% high, " + rarityMix.medium + "% medium, " + rarityMix.common + "% common." : "Upload distinct artwork editions here. Any supply beyond the uploaded editions repeats their artwork."}</p><label className="drop-wizard__field">Artwork files<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setFiles((current) => [...current, ...Array.from(event.target.files ?? []).map((file) => ({ file }))])} /></label>{files.length > 0 && <small>{files.length} files selected{files.some((item) => item.attributes?.length) ? ' · AI trait metadata included' : ''}</small>}<label className="drop-wizard__field">Description <small>optional</small><textarea value={artworkDescription} onChange={(event) => setArtworkDescription(event.target.value)} rows={3} placeholder="Describe this artwork" /></label><div className="drop-wizard__art-grid drop-wizard__art-grid--editable">{draft.artwork.map((art) => <div className="drop-wizard__art-edit" key={art.id}><img src={art.image} alt={art.name} /><small>{art.name}</small><label>Description<textarea rows={3} value={art.description} onChange={(event) => setDraft((current) => ({ ...current, artwork: current.artwork.map((item) => item.id === art.id ? { ...item, description: event.target.value } : item) }))} placeholder="Describe this artwork" /></label><Button variant="outline" onClick={() => void saveArtworkDetails(art.id)} disabled={busy || draft.launched}>Save artwork details</Button></div>)}</div><Button onClick={saveArtwork} disabled={busy || !files.length}>{busy ? 'Saving artwork…' : 'Save artwork'}</Button></div>}
      {step === 1 && <div className="drop-wizard__panel"><h3>2. Choose when minting starts</h3><p>Stages run one after another from this start time. Set each stage’s duration on the next step.</p><label className="drop-wizard__field">Mint starts<input type="datetime-local" value={dateValue} onChange={(event) => setDraft((value) => ({ ...value, startTime: event.target.value ? new Date(event.target.value).toISOString() : '' }))} /></label><Button onClick={saveStart} disabled={busy}>Save start date</Button></div>}
      {step === 2 && <div className="drop-wizard__panel"><h3>3. Set mint stages</h3><p>{draft.masterArtworkExpansion ? "Add team or presale stages, then allocate the collection supply across them. Master artwork is reused; each edition gets unique metadata and the selected rarity mix." : "Add team or presale stages, then allocate the collection supply across them. Artwork and metadata editions follow the files you select."}</p><div className="drop-wizard__stage-form"><label>Stage<select value={kind} onChange={(event) => setKind(event.target.value as MintStage['kind'])}>{['team','guaranteed','fcfs','public'].map((item) => <option key={item} value={item}>{mintKindLabel(item)}</option>)}</select></label><label>Stage name<input value={stageName} onChange={(event) => setStageName(event.target.value)} placeholder={mintKindLabel(kind)} /></label><label>Duration (hours)<input type="number" min="1" max="8760" value={duration} onChange={(event) => setDuration(event.target.value)} /></label><label>Price (XLM)<input value={stagePrice} onChange={(event) => setStagePrice(event.target.value)} /></label><label>Max per wallet<input type="number" min="1" max="1000" value={walletLimit} onChange={(event) => setWalletLimit(event.target.value)} /></label><label>NFTs allocated to this stage<input type="number" min="1" max={collection.totalSupply ? Math.max(0, collection.totalSupply - draft.stages.reduce((total, item) => total + (item.maxSupply ?? 0), 0)) : undefined} value={stageSupply} onChange={(event) => setStageSupply(event.target.value)} placeholder={collection.totalSupply ? `Up to ${Math.max(0, collection.totalSupply - draft.stages.reduce((total, item) => total + (item.maxSupply ?? 0), 0))} remaining` : "Enter stage allocation"} /></label><small className="drop-wizard__supply-hint">Collection total: {Number(collection.totalSupply ?? 0).toLocaleString()} · Already allocated: {draft.stages.reduce((total, item) => total + (item.maxSupply ?? 0), 0).toLocaleString()} · Remaining: {Math.max(0, Number(collection.totalSupply ?? 0) - draft.stages.reduce((total, item) => total + (item.maxSupply ?? 0), 0)).toLocaleString()}</small></div><b className="drop-wizard__subhead">Artwork in this stage</b><div className="drop-wizard__art-grid">{draft.artwork.map((art) => <label className="drop-wizard__art-choice" key={art.id}><input type="checkbox" checked={selectedArt.includes(art.id)} onChange={(event) => setSelectedArt((ids) => event.target.checked ? [...ids, art.id] : ids.filter((id) => id !== art.id))} /><img src={art.image} alt="" /><small>{art.name}</small></label>)}</div><Button onClick={addStageDraft} disabled={busy || !draft.artwork.length}>Save stage</Button><div className="drop-wizard__saved-list">{draft.stages.map((stage) => <div key={stage.key}><span><b>{stage.name}</b><small>{mintKindLabel(stage.kind)} · {stage.durationHours}h · {stage.price} XLM · {stage.perWalletLimit} per wallet · {stage.maxSupply} allocated</small></span><Button variant="quiet" onClick={() => void removeStageDraft(stage.key)} disabled={busy || Boolean(draft.stageIds?.[stage.key])}>Remove</Button></div>)}</div></div>}
      {step === 3 && <div className="drop-wizard__panel"><h3>4. Whitelist wallets in batches</h3><p>Choose a presale stage and paste one Stellar address per line. Optional CSV columns: address, wallet limit, custom price.</p><label className="drop-wizard__field">Presale stage<select value={allowlistStage} onChange={(event) => setAllowlistStage(event.target.value)}><option value="">Choose stage</option>{presales.map((stage) => <option key={stage.key} value={stage.key}>{stage.name}</option>)}</select></label><label className="drop-wizard__field">Wallet addresses<textarea rows={7} value={addressBatch} onChange={(event) => setAddressBatch(event.target.value)} placeholder={'GABC…\nGDEF…\nGHIJ…,2,0.5'} /></label><Button onClick={saveAddressBatch} disabled={busy || !addressBatch.trim()}>Save addresses for this stage</Button>{allowlistStage && <div className="drop-wizard__saved-list"><b>{draft.allowlists[allowlistStage]?.length ?? 0} saved addresses</b>{(draft.allowlists[allowlistStage] ?? []).map((entry) => <small key={entry.wallet}>{entry.wallet}{entry.customLimit ? ` · limit ${entry.customLimit}` : ''}{entry.customPrice ? ` · ${entry.customPrice} XLM` : ''}</small>)}</div>}</div>}
      {step === 4 && <div className="drop-wizard__panel"><h3>5. Preview your drop</h3><p>Review artwork, stage order, access lists and timing. Launch publishes the stages to Stellar Testnet.</p><div className="drop-wizard__preview"><b>{collection.name}</b><small>Starts {draft.startTime ? new Date(draft.startTime).toLocaleString() : 'Not set'}</small><small>{rarityCounts.high.toLocaleString()} high · {rarityCounts.medium.toLocaleString()} medium · {rarityCounts.common.toLocaleString()} common rarity editions across the collection</small>{previewStages.map(({ stage, start, end }, index) => <div className="drop-wizard__preview-stage" key={stage.key}><b>{index + 1}. {stage.name} · {mintKindLabel(stage.kind)}</b><small>{new Date(start).toLocaleString()} – {new Date(end).toLocaleString()}</small><small>{stage.price} XLM · {stage.perWalletLimit} max per wallet · {stage.maxSupply} allocated mints</small><small>{stage.artworkIds.length} artwork files · {draft.allowlists[stage.key]?.length ?? 0} allowlisted addresses</small><div className="drop-wizard__art-grid">{stage.artworkIds.map((id) => draft.artwork.find((art) => art.id === id)).filter((art): art is CollectionDropDraft['artwork'][number] => Boolean(art)).map((art) => <div key={art.id}><img src={art.image} alt={art.name} /><small>{art.name}</small></div>)}</div></div>)}</div>{draft.launched ? <p className="drop-wizard__success">This drop is already launched.</p> : <Button onClick={launch} disabled={busy || Boolean(draft.launched) || !draft.startTime || !draft.artwork.length || !draft.stages.length}>{busy ? 'Launching…' : 'Launch drop'}</Button>}</div>}
      {message && <p className="drop-wizard__message" role="status">{message}</p>}
    </div>}
    <div className="drop-wizard__footer"><Button variant="quiet" onClick={() => void clearSavedSetup()} disabled={loading || busy || Boolean(draft.launched)}>Clear saved setup</Button><span><Button variant="outline" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={busy || step === 0}>Back</Button><Button variant="outline" onClick={() => setStep((current) => Math.min(4, current + 1))} disabled={busy || step === 4}>Next</Button></span></div>
  </div>
}

function NftProvenance({ contractId, tokenId }: { contractId?: string; tokenId?: number }) {
  const [record, setRecord] = useState<NftProvenanceRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    if (!contractId || tokenId === undefined) { setRecord(null); setLoading(false); setError(false); return }
    setLoading(true)
    setError(false)
    void fetchNftProvenance(contractId, tokenId)
      .then((value) => { if (active) setRecord(value) })
      .catch(() => { if (active) { setRecord(null); setError(true) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [contractId, tokenId])
  if (!contractId || tokenId === undefined) return null
  const hash = (value: string | null) => value ? <code title={value}>{value}</code> : <span>Not recorded</span>
  const rows = record ? [
    ...(record.creator_wallet ? [{ label: 'Creator wallet', value: <code title={record.creator_wallet}>{shortenStellarAddress(record.creator_wallet)}</code> }] : []),
    ...(record.creation_method ? [{ label: 'Creation workflow', value: <span>{({ 'pixel-studio': 'Pixel Studio', 'ai-studio': 'AI Art Studio', 'ai-collection-studio': 'AI Collection Studio', 'painter-studio': 'Painter & Mural Studio', 'collection-settings': 'Collection mint setup', 'quick-mint': 'Quick mint', 'creator-import': 'Creator import' } as Record<string, string>)[record.creation_method] ?? 'StellaNova creator flow'}</span> }] : []),
    { label: 'Minted by', value: <code title={record.minter}>{shortenStellarAddress(record.minter)}</code> },
    { label: record.asset_sha256_verified ? 'Artwork · SHA-256 (server verified)' : 'Artwork · SHA-256 (unverified)', value: hash(record.asset_sha256) },
    ...(record.animation_sha256 ? [{ label: record.animation_sha256_verified ? 'Animation · SHA-256 (server verified)' : 'Animation · SHA-256 (unverified)', value: hash(record.animation_sha256) }] : []),
    { label: 'Metadata · SHA-256', value: hash(record.metadata_sha256) },
    { label: 'Mint transaction', value: <a href={`${STELLAR_EXPLORER_URL}/tx/${record.mint_tx_hash}`} target="_blank" rel="noreferrer">{record.mint_tx_hash.slice(0, 8)}…{record.mint_tx_hash.slice(-6)} · ledger #{record.mint_ledger.toLocaleString()} <Icon name="arrow" size={12} /></a> },
    ...(record.metadata_uri ? [{ label: 'Metadata document', value: <a href={record.metadata_uri} target="_blank" rel="noreferrer">Open JSON <Icon name="arrow" size={12} /></a> }] : []),
    ...(record.metadata_created_at ? [{ label: 'Metadata recorded', value: <span>{new Date(record.metadata_created_at).toLocaleString()}</span> }] : []),
  ] : []
  return <section className="nft-provenance" aria-label="NFT provenance record">
    <div className="section-title"><div><span className="eyebrow">ORIGIN RECORD</span><h3>Artwork provenance</h3></div></div>
    <p>Creator metadata and the confirmed Stellar mint are recorded here. Artwork fingerprints are marked when StellaNova independently verified the uploaded bytes. A fingerprint identifies file bytes; it does not establish copyright or authorship.</p>
    {loading ? <p className="muted-note">Loading provenance record…</p> : error ? <p className="muted-note">Provenance details could not be loaded right now.</p> : rows.length ? <dl>{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl> : <p className="muted-note">No confirmed mint record is available yet.</p>}
  </section>
}

function NftChainActivity({ contractId, tokenId }: { contractId?: string; tokenId?: number }) {
  const [activity, setActivity] = useState<NftChainActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    if (!contractId || tokenId === undefined) { setActivity([]); setLoading(false); setError(false); return }
    setLoading(true)
    setError(false)
    void fetchNftChainActivity(contractId, tokenId)
      .then((items) => { if (active) setActivity(items) })
      .catch(() => { if (active) { setActivity([]); setError(true) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [contractId, tokenId])
  const address = (value: string | null) => value ? shortenStellarAddress(value) : 'Unknown wallet'
  const label = (entry: NftChainActivityEntry) => {
    if (entry.kind === 'mint') return `Minted to ${address(entry.to)}`
    if (entry.kind === 'sale') return `Sold · ${address(entry.from)} → ${address(entry.to)}${entry.amount_xlm ? ` · ${entry.amount_xlm} XLM` : ''}`
    return `Transferred · ${address(entry.from)} → ${address(entry.to)}`
  }
  return <section className="nft-chain-activity" aria-label="Verified NFT on-chain activity">
    <div className="section-title"><div><span className="eyebrow">VERIFIED ON-CHAIN</span><h3>Ownership history</h3></div></div>
    <p>Mint and ownership changes confirmed by Stellar contract events.</p>
    {loading ? <p className="muted-note">Loading confirmed activity…</p> : error ? <p className="muted-note">Confirmed activity could not be loaded right now.</p> : activity.length ? <ol>{activity.map((entry) => <li key={`${entry.tx_hash}:${entry.kind}`}><span><b>{label(entry)}</b><small>Ledger #{entry.ledger.toLocaleString()}</small></span><a href={`${STELLAR_EXPLORER_URL}/tx/${entry.tx_hash}`} target="_blank" rel="noreferrer" title="Open confirmed transaction in Stellar Expert">{entry.tx_hash.slice(0, 7)}…{entry.tx_hash.slice(-5)} <Icon name="arrow" size={12} /></a></li>)}</ol> : <p className="muted-note">No confirmed mint or transfer history is indexed yet.</p>}
  </section>
}

function CollectionMintHistory({ slug }: { slug: string }) {
  const [wallets, setWallets] = useState<CollectionMintHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    setLoading(true)
    void fetchCollectionMintHistory(slug)
      .then((items) => { if (active) setWallets(items) })
      .catch(() => { if (active) setWallets([]) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [slug])
  const total = wallets.reduce((sum, entry) => sum + entry.total_minted, 0)
  return <section className="section-block collection-mint-history collection-page-subsection">
    <div className="section-title"><div><span className="eyebrow">ON-CHAIN ACTIVITY</span><h3>Mint history</h3></div><span className="muted-note">{total.toLocaleString()} total minted · {wallets.length.toLocaleString()} wallets</span></div>
    <p className="muted-note">Confirmed NFT mints across creator mints and public sale stages. Contract deployments are not counted.</p>
    {loading ? <p className="muted-note">Loading confirmed mints…</p> : wallets.length ? <div className="collection-mint-history__rows">{wallets.map((entry) => <div className="collection-mint-history__row" key={entry.wallet}><span><Icon name="wallet" size={16} /><b title={entry.wallet}>{shortenStellarAddress(entry.wallet)}</b></span><div><strong>{entry.total_minted.toLocaleString()} minted</strong><small>{entry.stages.map((stage) => `${stage.stage_minted} ${stage.stage_name}`).join(' · ')}</small></div></div>)}</div> : <p className="muted-note">No confirmed NFT mints yet.</p>}
  </section>
}

function CollectionMintTimeline({ collection, wallet, notify, setMintedNfts, onStageMintsConfirmed, onCollectionUpdated }: { collection: Collection; wallet: StellarWallet | null; notify: (m: string) => void; setMintedNfts: (items: MintedNft[]) => void; onStageMintsConfirmed: (inputs: MintRecordInput[]) => void; onCollectionUpdated: (id: string, changes: Partial<Collection>) => void }) {
  const slug = collection.id
  const address = wallet?.address
  const [drop, setDrop] = useState<CollectionDrop | null>(null)
  const [eligibility, setEligibility] = useState<MintEligibility | null>(null)
  const [nowIso, setNowIso] = useState(() => new Date().toISOString())
  const [manage, setManage] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dropMessage, setDropMessage] = useState('')
  const [placeholderArtwork, setPlaceholderArtwork] = useState<File | null>(null)
  const [hideMode, setHideMode] = useState(false)

  const [newKind, setNewKind] = useState<MintStage['kind']>('fcfs')
  const [newName, setNewName] = useState('')
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [newLimit, setNewLimit] = useState('1')
  const [newSupply, setNewSupply] = useState('')
  const [stageTitle, setStageTitle] = useState('')
  const [stageDescription, setStageDescription] = useState('')
  const [stageArtwork, setStageArtwork] = useState<File[]>([])
  const [stageAnimationFile, setStageAnimationFile] = useState<File | null>(null)
  const [stageTraits, setStageTraits] = useState('')
  const [wlStage, setWlStage] = useState<number | null>(null)
  const [wlCsv, setWlCsv] = useState('')
  const [mintingStage, setMintingStage] = useState<number | null>(null)
  const [mintQuantities, setMintQuantities] = useState<Record<number, number>>({})

  const reload = useCallback(() => {
    void fetchCollectionDrop(slug, address).then(setDrop).catch(() => {})
    void fetchMintEligibility(slug, address).then(setEligibility).catch(() => {})
  }, [slug, address])

  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    if (window.sessionStorage.getItem('stellanova:open-drop-setup') !== slug) return
    window.sessionStorage.removeItem('stellanova:open-drop-setup')
    setManage(true)
    setSetupOpen(true)
  }, [slug])
  useEffect(() => {
    const handleMintRecorded = (event: Event) => {
      const detail = (event as CustomEvent<{ collectionId?: string; tokenId?: number }>).detail
      if (detail?.collectionId !== slug) return
      setDropMessage(`Mint #${detail.tokenId} is indexed. No second NFT was created.`)
      reload()
    }
    window.addEventListener('nftgram:mint-recorded', handleMintRecorded)
    return () => window.removeEventListener('nftgram:mint-recorded', handleMintRecorded)
  }, [slug, reload])
  useEffect(() => {
    const t = window.setInterval(() => setNowIso(new Date().toISOString()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const isOwner = Boolean(drop?.isOwner)
  const stages = eligibility?.stages ?? []
  const hasDrop = Boolean(drop && drop.stages.length > 0)
  const nowMs = new Date(nowIso).getTime()

  const addStage = async () => {
    if (!wallet) { notify('Connect your wallet to configure the drop'); return }
    const contractId = drop?.collection.contractId ?? eligibility?.collection.contractId
    if (!contractId) { notify('Deploy the updated NFT contract before configuring this drop'); return }
    if (!newStart || !newEnd) { notify('Set a start and end time for the stage'); return }
    if (!stageTitle.trim()) { notify('Add the NFT name that buyers will mint'); return }
    if (!stageArtwork.length) { notify('Choose at least one edition artwork file'); return }
    const stageAllocation = Number(newSupply.trim())
    if (!Number.isSafeInteger(stageAllocation) || stageAllocation < 1 || stageAllocation > 1_000_000) { notify('Enter the number of NFTs allocated to this stage'); return }
    setDropMessage('')
    setBusy(true)
    try {
      const currentDrop = await fetchCollectionDrop(slug, wallet.address)
      if (!currentDrop.collection.revealed && !currentDrop.collection.placeholderMetadataUri) throw new Error('Set a placeholder and hide the collection before creating unrevealed stages')
      const animation = stageAnimationFile ? await uploadMedia(stageAnimationFile, slug, { walletAddress: wallet.address }) : null
      const animationUrl = animation?.original.r2Url ?? animation?.original.cloudinaryUrl ?? undefined
      if (stageArtwork.length > 10000) throw new Error('A stage supports up to 10,000 individual artwork editions')
      const editionGroup = stageArtwork.length > 1 ? crypto.randomUUID() : ''
      const metadataUris: string[] = []
      for (let i = 0; i < stageArtwork.length; i += 1) {
        const media = await uploadMedia(stageArtwork[i], slug, { walletAddress: wallet.address })
        const image = media.original.r2Url ?? media.original.cloudinaryUrl
        if (!image) throw new Error(`Artwork ${i + 1} did not return a public URL`)
        const metadata = await uploadCreatorMetadata(wallet.address, slug, {
          name: stageArtwork.length > 1 ? `${stageTitle.trim()} #${i + 1}` : stageTitle.trim(),
          description: stageDescription.trim(), image, animation_url: animationUrl, attributes: parseEditionTraits(stageTraits, i),
          creation_method: 'collection-settings',
          ...(editionGroup ? { edition_group: editionGroup, edition_index: i } : {}),
        })
        if (!metadata.url) throw new Error(`Metadata for edition ${i + 1} did not return a public URL`)
        metadataUris.push(metadata.url)
      }
      const stage = await createMintStage(wallet.address, slug, {
        kind: newKind,
        name: newName.trim() || undefined,
        startTime: newStart ? new Date(newStart + ':00Z').toISOString() : null,
        endTime: newEnd ? new Date(newEnd + ':00Z').toISOString() : null,
        price: newPrice.trim() === '' ? null : Number(newPrice.trim()),
        perWalletLimit: Number(newLimit.trim()) || 1,
        maxSupply: stageAllocation,
        metadataUris,
      })
      try {
        await setCreatorStage(wallet, contractId, {
          stageId: stage.id,
          kind: newKind,
          startTime: Math.floor(new Date(newStart + ':00Z').getTime() / 1000),
          endTime: Math.floor(new Date(newEnd + ':00Z').getTime() / 1000),
          priceStroops: xlmToStroops(newPrice),
          perWalletLimit: Number(newLimit.trim()) || 1,
          maxSupply: stageAllocation,
          sortOrder: stage.sortOrder,
          collectionSlug: slug,
          metadataUri: !currentDrop.collection.revealed
            ? currentDrop.collection.placeholderMetadataUri ?? ''
            : metadataUris.length > 1 ? metadataUris[0].replace(/0\.json$/, '') : metadataUris[0],
          editionCount: metadataUris.length,
        })
      } catch (error) {
        await deleteMintStage(wallet.address, slug, stage.id).catch(() => undefined)
        throw error
      }
      setNewName(''); setNewStart(''); setNewEnd(''); setNewPrice(''); setNewLimit('1'); setNewSupply('')
      setStageTitle(''); setStageDescription(''); setStageArtwork([]); setStageAnimationFile(null); setStageTraits('')
      reload()
      setDropMessage('Mint stage created and published to Stellar Testnet.')
      notify(`${mintKindLabel(newKind)} stage and mint artwork published to Stellar Testnet`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not add stage'
      setDropMessage(message)
      notify(message)
    } finally {
      setBusy(false)
    }
  }

  const removeStage = async (stageId: number) => {
    if (!wallet) return
    const contractId = drop?.collection.contractId ?? eligibility?.collection.contractId
    if (!contractId) { notify('This collection has no registered NFT contract'); return }
    setBusy(true)
    try {
      await removeCreatorStage(wallet, contractId, stageId)
      await deleteMintStage(wallet.address, slug, stageId)
      reload()
      notify('Stage removed')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not remove stage')
    } finally {
      setBusy(false)
    }
  }

  const saveWhitelist = async () => {
    if (!wallet || wlStage === null) return
    const contractId = drop?.collection.contractId ?? eligibility?.collection.contractId
    if (!contractId) { notify('This collection has no registered NFT contract'); return }
    const rows = wlCsv.split(/\n/).map((line) => line.trim()).filter(Boolean)
    const entries = rows.map((line) => {
      const parts = line.split(',').map((p) => p.trim())
      return { wallet: parts[0], customLimit: parts[1] ? Number(parts[1]) : null, customPrice: parts[2] ? Number(parts[2]) : null }
    })
    if (!entries.length) { notify('Enter wallet addresses to whitelist'); return }
    if (entries.some((entry) => !/^G[A-Z2-7]{55}$/.test(entry.wallet))) { notify('Every allowlist row needs a valid Stellar G-address'); return }
    setBusy(true)
    try {
      for (const entry of entries) {
        await whitelistCreatorWallet(wallet, contractId, wlStage, {
          wallet: entry.wallet, allowed: true, customLimit: entry.customLimit ?? null,
          customPriceStroops: entry.customPrice === null ? null : xlmToStroops(String(entry.customPrice)),
        })
      }
      const res = await addWhitelistEntries(wallet.address, slug, wlStage, entries)
      setWlCsv('')
      reload()
      notify(`${res.added} wallet${res.added === 1 ? '' : 's'} whitelisted for stage #${wlStage}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not update allowlist')
    } finally {
      setBusy(false)
    }
  }

  const revokeWhitelist = async (entry: { stage_id: number; wallet: string }) => {
    if (!wallet) return
    const contractId = drop?.collection.contractId ?? eligibility?.collection.contractId
    if (!contractId) { notify('This collection has no registered NFT contract'); return }
    setBusy(true)
    try {
      await whitelistCreatorWallet(wallet, contractId, entry.stage_id, {
        wallet: entry.wallet, allowed: false, customLimit: null, customPriceStroops: null,
      })
      await removeWhitelistEntry(wallet.address, slug, entry.stage_id, entry.wallet)
      reload()
      notify('Wallet removed from the allowlist')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not remove wallet from allowlist')
    } finally {
      setBusy(false)
    }
  }

  const changeRevealState = async (revealed: boolean) => {
    if (!wallet) { notify('Connect your creator wallet to change reveal state'); return }
    const contractId = drop?.collection.contractId ?? eligibility?.collection.contractId
    if (!contractId) { notify('This collection has no registered NFT contract'); return }
    setBusy(true)
    try {
      let placeholderUri = drop?.collection.placeholderMetadataUri ?? ''
      if (!revealed) {
        if (!placeholderArtwork) throw new Error('Choose a placeholder image before hiding the artwork')
        const media = await uploadMedia(placeholderArtwork, slug, { walletAddress: wallet.address })
        const image = media.original.r2Url ?? media.original.cloudinaryUrl
        if (!image) throw new Error('Placeholder upload did not return a public URL')
        const metadata = await uploadCreatorMetadata(wallet.address, slug, { name: `${collection.name} — Unrevealed`, description: 'Artwork has not been revealed yet.', image, attributes: [] })
        placeholderUri = metadata.url ?? ''
        if (!placeholderUri) throw new Error('Placeholder metadata did not return a public URL')
        await updateCollectionReveal(wallet.address, slug, { revealed: false, placeholderUri })
        try {
          await setCreatorReveal(wallet, contractId, { collectionScope: slug, revealed: false, placeholderUri })
        } catch (error) {
          await updateCollectionReveal(wallet.address, slug, { revealed: true }).catch(() => undefined)
          throw error
        }
      } else {
        const { tokens, contractIds } = await fetchCollectionRevealMetadata(wallet.address, slug)
        const metadataByContract = new Map<string, Map<number, string>>()
        for (const token of tokens) {
          const contractKey = token.contract_id.toLowerCase()
          const metadata = metadataByContract.get(contractKey) ?? new Map<number, string>()
          metadata.set(Number(token.token_id), token.metadata_uri)
          metadataByContract.set(contractKey, metadata)
        }
        const revealContracts = [...new Set([contractId, ...contractIds])]
        const tokenIdsByContract = await Promise.all(revealContracts.map(async (nftContractId) => ({
          contractId: nftContractId,
          tokenIds: await getCreatorCollectionTokenIds(wallet, nftContractId, slug),
        })))
        for (const { contractId: nftContractId, tokenIds } of tokenIdsByContract) {
          const metadataByToken = metadataByContract.get(nftContractId.toLowerCase()) ?? new Map<number, string>()
          if (metadataByToken.size !== tokenIds.length || tokenIds.some((tokenId) => !metadataByToken.has(tokenId))) {
            throw new Error('Some collection mints are still being indexed. Wait a moment and retry reveal.')
          }
        }
        for (const nftContractId of revealContracts) {
          await setCreatorReveal(wallet, nftContractId, { collectionScope: slug, revealed: true, placeholderUri })
          const tokenIds = tokenIdsByContract.find((entry) => entry.contractId === nftContractId)?.tokenIds ?? []
          const metadataByToken = metadataByContract.get(nftContractId.toLowerCase()) ?? new Map<number, string>()
          for (let offset = 0; offset < tokenIds.length; offset += 20) {
            const batchIds = tokenIds.slice(offset, offset + 20)
            const batchUris = batchIds.map((tokenId) => metadataByToken.get(tokenId)!)
            await setCreatorTokenUris(wallet, nftContractId, slug, batchIds, batchUris)
          }
        }
      }
      await updateCollectionReveal(wallet.address, slug, { revealed, placeholderUri })
      onCollectionUpdated(slug, { revealed })
      setPlaceholderArtwork(null)
      reload()
      notify(revealed ? 'Collection artwork revealed on Stellar Testnet' : 'Collection artwork hidden until you reveal it')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not change reveal state')
    } finally { setBusy(false) }
  }

  const doStageMint = async (stage: MintEligibilityStage) => {
    if (mintingStage !== null) return
    if (!wallet) { notify('Connect your wallet to mint'); return }
    const contractId = drop?.collection.contractId ?? eligibility?.collection.contractId
    if (!contractId) { notify('This collection has no registered NFT contract'); return }
    const pendingMints = getPendingMintRecords(wallet.address).filter((item) => item.collectionId === slug && item.stageId === stage.stageId)
    if (pendingMints.length) {
      setMintingStage(stage.stageId)
      try {
        await Promise.all(pendingMints.map((item) => recordMintedNft(wallet.address, item)))
        setMintedNfts(await fetchMintedNfts())
        setDropMessage(`${pendingMints.length} confirmed mint${pendingMints.length === 1 ? '' : 's'} indexed. No additional NFTs were created.`)
        notify(`${pendingMints.length} confirmed mint${pendingMints.length === 1 ? '' : 's'} indexed. No additional NFTs were created.`)
        reload()
      } catch (error) { const message = error instanceof Error ? error.message : 'Mint indexing is still pending'; setDropMessage(message); notify(message) }
      finally { setMintingStage(null) }
      return
    }
    const maxQuantity = Math.max(0, Math.min(stage.remainingForWallet ?? stage.perWalletLimit, stage.remainingSupply ?? stage.maxSupply ?? stage.perWalletLimit))
    const quantity = Math.min(Math.max(1, mintQuantities[stage.stageId] ?? 1), maxQuantity)
    if (!quantity) { notify('This wallet or stage has no mint allocation remaining'); return }
    setDropMessage('')
    setMintingStage(stage.stageId)
    try {
      const { tokenIds, editionStart, hash, transactionCount } = await mintFromStage(wallet, contractId, stage.stageId, quantity, (chunk) => {
        const confirmedInputs = chunk.tokenIds.map((tokenId, index) => {
          const metadataIndex = stage.metadataUris.length ? (chunk.editionStart + index) % stage.metadataUris.length : 0
          const metadataUri = drop?.collection.revealed
            ? (stage.metadataUris.length > 1 ? stage.metadataUris[metadataIndex] ?? '' : stage.metadataUri)
            : ''
          return {
            tokenId,
            collectionId: slug,
            contractId,
            title: stage.metadataName || `NFT #${tokenId}`,
            image: stage.metadataImage || '',
            metadataUri,
            txHash: chunk.hash,
            stageId: stage.stageId,
          }
        })
        onStageMintsConfirmed(confirmedInputs)
        void Promise.allSettled(confirmedInputs.map((input) => recordMintedNft(wallet.address, input))).then(async () => {
          setMintedNfts(await fetchMintedNfts())
        })
        setDropMessage(`Confirmed ${chunk.tokenIds.length} of ${quantity} requested mints${quantity > chunk.tokenIds.length ? '…' : '.'}`)
      })
      if (!tokenIds.length) throw new Error(`Stage mint ${hash} confirmed but returned no token ids`)
      setMintedNfts(await fetchMintedNfts())
      const firstId = tokenIds[0]
      const lastId = tokenIds[tokenIds.length - 1]
      setMintQuantities((current) => ({ ...current, [stage.stageId]: Math.max(1, quantity - tokenIds.length) }))
      const transactionText = transactionCount === 1 ? 'one transaction' : `${transactionCount} transactions`
      setDropMessage(`Minted ${tokenIds.length} NFT${tokenIds.length === 1 ? '' : 's'} in ${transactionText} (#${firstId}${lastId !== firstId ? `–#${lastId}` : ''}) on Stellar Testnet.`)
      notify(`Minted ${tokenIds.length} NFT${tokenIds.length === 1 ? '' : 's'} in ${transactionText} on Stellar Testnet`)
      reload()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Minting failed'
      setDropMessage(message)
      notify(message)
      setMintedNfts(await fetchMintedNfts())
    } finally {
      setMintingStage(null)
    }
  }

  return (
    <>
    <CollectionPublicInfo collection={collection} owner={isOwner} wallet={wallet} notify={notify} onUpdated={(changes) => onCollectionUpdated(collection.id, changes)} />
    {setupOpen && isOwner && <CollectionDropSetup collection={collection} wallet={wallet} notify={notify} onClose={() => setSetupOpen(false)} onLaunched={() => { reload(); setSetupOpen(false) }} />}
    <section className="section-block mint-timeline collection-page-subsection">
      <div className="section-title">
        <div><span className="eyebrow">PUBLIC DROP · OPTIONAL</span><h3>{hasDrop ? 'Scheduled sale & allowlists' : 'No public drop scheduled'}</h3></div>
        {isOwner && <span className="timeline-actions"><Button variant="quiet" onClick={() => setSetupOpen(!setupOpen)}>{setupOpen ? 'Close setup' : hasDrop ? 'Edit drop setup' : 'Set up mint drop'} <Icon name="chevron" size={13} /></Button></span>}
      </div>
      {dropMessage && <div role="status" aria-live="polite" className="detail-note"><Icon name="activity" size={16} /><span><b>{dropMessage.includes('confirmed on Stellar Testnet') ? 'Mint confirmed; indexing pending' : dropMessage.startsWith('Partial mint:') ? 'Mint partially completed' : dropMessage.startsWith('Minted') || dropMessage.includes('indexed.') || dropMessage.includes('Mint stage created') ? 'Collection mint succeeded' : 'Collection mint failed'}</b><small>{dropMessage}</small></span></div>}

      {isOwner && drop?.collection && <div className="drop-manager__head"><strong>Artwork reveal</strong><small>{drop.collection.revealed ? 'Revealed: artwork and metadata are public.' : 'Unrevealed: collectors see the placeholder artwork.'}</small><div className="mint-stage__manage">{drop.collection.revealed ? hideMode ? <><label>Placeholder artwork<input className="offer-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setPlaceholderArtwork(event.target.files?.[0] ?? null)} />{placeholderArtwork && <small>{placeholderArtwork.name}</small>}</label><Button onClick={() => void changeRevealState(false)} disabled={busy || !placeholderArtwork}>{busy ? 'Hiding…' : 'Confirm hide'}</Button><Button variant="outline" onClick={() => { setHideMode(false); setPlaceholderArtwork(null) }} disabled={busy}>Cancel</Button></> : <Button variant="outline" onClick={() => setHideMode(true)}>Hide artwork</Button> : <Button onClick={() => void changeRevealState(true)} disabled={busy}>{busy ? 'Revealing…' : 'Reveal collection'}</Button>}</div></div>}

      {manage && isOwner && (
        <div className="drop-manager">
          <div className="drop-manager__head"><strong>Add a mint stage</strong><small>Presale stages need an allowlist; the public stage is open to everyone and caps the timeline.</small></div>
          <div className="drop-manager__grid">
            <label>Kind<select className="offer-input" value={newKind} onChange={(e) => setNewKind(e.target.value as MintStage['kind'])}>{['team', 'guaranteed', 'fcfs', 'public'].map((k) => <option key={k} value={k}>{mintKindLabel(k)}</option>)}</select></label>
            <label>Name<small>(optional)</small><input className="offer-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Community sprint" /></label>
            <label>Start (UTC)<input className="offer-input" type="datetime-local" value={newStart} onChange={(e) => setNewStart(e.target.value)} /></label>
            <label>End (UTC)<input className="offer-input" type="datetime-local" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} /></label>
            <label>Price (XLM)<input className="offer-input" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="0.5" inputMode="decimal" /></label>
            <label>Per-wallet limit<input className="offer-input" value={newLimit} onChange={(e) => setNewLimit(e.target.value)} placeholder="1" inputMode="numeric" /></label>
            <label>NFTs allocated to this stage <small>Part of the collection total supply</small><input className="offer-input" type="number" min="1" max={collection.totalSupply ?? undefined} value={newSupply} onChange={(e) => setNewSupply(e.target.value)} placeholder="Enter stage allocation" inputMode="numeric" required /></label>
            <label>NFT name<input className="offer-input" value={stageTitle} onChange={(e) => setStageTitle(e.target.value)} placeholder="Name buyers will receive" /></label>
            <label className="drop-manager__csv">NFT description<textarea className="offer-input" rows={2} value={stageDescription} onChange={(e) => setStageDescription(e.target.value)} placeholder="Description shown in NFT metadata" /></label>
            <label>Edition artwork<input className="offer-input" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { setStageArtwork(Array.from(e.target.files ?? [])); setNewSupply('') }} />{stageArtwork.length > 0 && <small>{stageArtwork.length} image{stageArtwork.length === 1 ? '' : 's'} selected. Multiple files create distinct editions in upload order (up to 10,000).</small>}</label>
            <label>Animation / audio / 3D file <small>optional shared media, max 25 MB</small><input className="offer-input" type="file" accept="video/mp4,video/webm,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,.glb,.gltf" onChange={(e) => setStageAnimationFile(e.target.files?.[0] ?? null)} />{stageAnimationFile && <small>{stageAnimationFile.name}</small>}</label>
            <label className="drop-manager__csv">Traits <small>Shared: trait: value · Per edition: #2 trait: value</small><textarea className="offer-input" rows={3} value={stageTraits} onChange={(e) => setStageTraits(e.target.value)} placeholder={'Background: Blue\n#2 Eyes: Star\n#3 Eyes: Diamond'} /></label>
            <div className="drop-manager__go"><Button onClick={addStage} disabled={busy}>Add stage <Icon name="plus" size={14} /></Button></div>
          </div>
          <div className="drop-manager__divider">Allowlists</div>
          <div className="drop-manager__head"><strong>Whitelist wallets for a stage</strong><small>One wallet per line: wallet, customLimit?, customPrice? (CSV). Applies to presale stages only.</small></div>
          <div className="drop-manager__grid">
            <label>Stage<select className="offer-input" value={wlStage ?? ''} onChange={(e) => setWlStage(Number(e.target.value))}><option value="">Choose a presale stage…</option>{drop?.stages.filter((s) => s.kind !== 'public').map((s) => <option key={s.id} value={s.id}>Stage #{s.id} · {mintKindLabel(s.kind)}</option>)}</select></label>
            <label className="drop-manager__csv">Wallets<textarea className="offer-input" rows={3} value={wlCsv} onChange={(e) => setWlCsv(e.target.value)} placeholder="walletAddress,customLimit?,customPrice?" /></label>
            <div className="drop-manager__go"><Button onClick={saveWhitelist} disabled={busy || wlStage === null}>Save allowlist <Icon name="arrow" size={14} /></Button></div>
          </div>
          {wlStage !== null && (drop?.whitelist ?? []).filter((entry) => entry.stage_id === wlStage).length > 0 && (
            <div className="drop-manager__head"><strong>Current allowlist</strong>
              {(drop?.whitelist ?? []).filter((entry) => entry.stage_id === wlStage).map((entry) => (
                <div className="mint-stage__manage" key={entry.wallet}>
                  <span><code>{entry.wallet}</code>{entry.custom_limit ? ` · limit ${entry.custom_limit}` : ''}{entry.custom_price ? ` · ${mintXlm(entry.custom_price)}` : ''}</span>
                  <Button variant="quiet" onClick={() => revokeWhitelist(entry)} disabled={busy}>Remove</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!hasDrop && !manage && <div className="empty-state empty-state--compact"><span className="empty-state__icon"><Icon name="bookmark" size={20} /></span><h3>{isOwner ? 'Ready to set up your mint drop?' : 'No public sale scheduled.'}</h3><p>{isOwner ? 'Configure mint stages, price, timing and allowlists for collectors. Artwork saved from AI Collection Studio is loaded into the setup automatically. You can also mint NFTs directly to your wallet at any time.' : 'The creator has not scheduled a public sale.'}</p>{isOwner && <Button onClick={() => setSetupOpen(true)}><Icon name="plus" size={14} /> Set up mint drop</Button>}</div>}

      {hasDrop && (
        <div className="mint-stage-list">
          {stages.map((stage) => {
            const startMs = stage.startTime ? new Date(stage.startTime).getTime() : null
            const endMs = stage.endTime ? new Date(stage.endTime).getTime() : null
            const live = (startMs === null || startMs <= nowMs) && (endMs === null || endMs >= nowMs)
            const upcoming = startMs !== null && startMs > nowMs
            const past = endMs !== null && endMs < nowMs
            const allowlisted = stage.status === 'team' || stage.status === 'guaranteed' || stage.status === 'fcfs'
            const quantityLimit = Math.max(0, Math.min(stage.remainingForWallet ?? stage.perWalletLimit, stage.remainingSupply ?? stage.maxSupply ?? stage.perWalletLimit))
            const selectedQuantity = Math.min(Math.max(1, mintQuantities[stage.stageId] ?? 1), quantityLimit)
            const unitPrice = Number(stage.customPrice ?? stage.price ?? 0)
            const totalPrice = unitPrice * selectedQuantity
            const totalPriceLabel = totalPrice > 0 ? `${totalPrice.toLocaleString(undefined, { maximumFractionDigits: 7 })} XLM` : 'Free'
            return (
              <div className={`mint-stage ${live ? 'is-live' : ''} ${past ? 'is-past' : ''}`} key={stage.stageId}>
                <div className="mint-stage__body">
                  <div className="mint-stage__row">
                    <span><b>{stage.name}</b><small>{mintWindow(stage.startTime, stage.endTime)}</small></span>
                    <span className="mint-stage__price"><small>Price</small><b>{stage.customPrice !== null ? mintXlm(stage.customPrice) : mintXlm(stage.price)}</b></span>
                    <span className="mint-stage__limit"><small>Per wallet</small><b>{stage.perWalletLimit}</b></span>
                  </div>
                  <div className="mint-stage__status">
                    {stage.status === 'public' && <span className="status-pill">Open to everyone</span>}
                    {stage.status === 'team' && <span className="status-pill">Team access</span>}
                    {stage.status === 'restricted' && <span className="status-pill is-muted">Whitelist only · connect wallet</span>}
                    {stage.status === 'not-whitelisted' && <span className="status-pill is-muted">Not on the allowlist</span>}
                    {upcoming && <span className="status-pill is-muted">Starts in {formatMintCountdown(startMs - nowMs)}</span>}
                    {upcoming && <span className="status-pill is-muted">Opens {new Date(startMs).toLocaleString(undefined, { timeZone: 'UTC' })} UTC</span>}
                    {past && <span className="status-pill is-muted">Ended · minting closed</span>}
                    {live && <span className="status-pill is-live-pill">{endMs !== null ? `Live now · ends in ${formatMintCountdown(endMs - nowMs)}` : 'Live now'}</span>}
                  </div>
                  {past && <small className="mint-stage__closed-note">This stage ended at its scheduled end time. The NFT contract now rejects mints for this stage.</small>}
                  {manage && isOwner && (
                    <div className="mint-stage__manage">
                      <span>WL: <b>{drop?.whitelistCounts?.[stage.stageId] ?? 0}</b> wallets</span>
                      {stage.kind !== 'public' && <Button variant="quiet" onClick={() => { setWlStage(stage.stageId); setManage(true) }}>Edit allowlist</Button>}
                      {stage.kind !== 'public' && <Button variant="quiet" onClick={() => removeStage(stage.stageId)} disabled={busy}>Remove</Button>}
                    </div>
                  )}
                  {live && (stage.status === 'public' || allowlisted) && (quantityLimit > 0 ? (
                    <div className="mint-stage__cta"><label className="mint-stage__quantity">Quantity <input className="offer-input" aria-label={`Quantity to mint in ${stage.name}`} type="number" min={1} max={quantityLimit} step={1} inputMode="numeric" value={selectedQuantity} onChange={(event) => setMintQuantities((current) => ({ ...current, [stage.stageId]: Math.max(1, Math.min(quantityLimit, Number.parseInt(event.target.value, 10) || 1)) }))} /></label><Button onClick={() => doStageMint(stage)} disabled={mintingStage !== null}><Icon name="bookmark" size={14} /> {mintingStage === stage.stageId ? `Minting ${selectedQuantity}…` : `Mint ${selectedQuantity} · ${totalPriceLabel}`}</Button></div>
                  ) : <span className="status-pill is-muted mint-stage__limit-message">{stage.remainingSupply === 0 ? 'Stage sold out' : 'Wallet limit reached'}</span>)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
    </>
  )
}

export default App
