export type Creator = {
  id: string
  name: string
  handle: string
  publicSlug?: string
  avatar: string
  bio: string
  collectorCount: string
  collectionCount: string
  verified?: boolean
  accent: string
}

export type NFT = {
  id: string
  title: string
  creatorId: string
  collectionId: string
  image: string
  animation_url?: string | null
  attributes?: { trait_type: string; value: string | number | boolean }[]
  rarity_rank?: number | null
  rarity_score?: number | null
  price: string
  priceUsd: string
  edition: string
  likes: number
  comments: number
  minted: string
  ownedBy: string
  trait: string
  trend?: string
  saleType: 'Buy now' | 'Auction' | 'Offers' | 'Not listed'
  chain: string
  royalty: string
  ownerAddress?: string
  contractId?: string
  tokenId?: number
  createdAt?: string
  bestOffer?: string
  auctionEnds?: string
}

export type Collection = {
  id: string
  name: string
  symbol: string
  creatorId: string
  cover: string
  floor: string
  volume: string
  items: string
  change: string
  description: string
  contractId?: string
  totalSupply?: number | null
  websiteUrl?: string | null
  socialLinks?: Record<string, string>
  isSample?: boolean
  mintingNow?: boolean
  revealed?: boolean
}

// These collections are loaded by scripts/seed-testnet-feed.ts for visual testing.
export const sampleCollectionSlugs = new Set([
  'bloom-light-studies',
  'north-northline-fieldnotes',
  'solar-horizon-notes',
  'frame-open-frame',
])

// Marketplace content comes from indexed Testnet records. Keep these empty so
// no curated or fabricated records can appear as live StellaNova activity.
export const creators: Creator[] = []
export const collections: Collection[] = []
export const nfts: NFT[] = []
export const activity: { type: string; label: string; note: string; time: string; amount: string; image: string }[] = []

export function creatorFor(id: string, profiles: Record<string, Creator> = {}): Creator {
  const profile = profiles[id.toLowerCase()]
  if (profile) return profile
  const knownCreator = creators.find((creator) => creator.id.toLowerCase() === id.toLowerCase())
  if (knownCreator) return knownCreator
  if (/^G[A-Z2-7]{55}$/.test(id)) {
    return {
      id, name: 'Stellar creator', handle: '', avatar: '', bio: 'Creator on Stellar',
      collectorCount: '0', collectionCount: '0', accent: '#833ab4',
    }
  }
  return {
    id, name: 'Creator details unavailable', handle: '', avatar: '', bio: '',
    collectorCount: '—', collectionCount: '—', accent: '#833ab4',
  }
}

export function collectionFor(id: string): Collection {
  if (id === 'standalone-nft') return {
    id, name: 'Standalone NFT', symbol: '', creatorId: '', cover: '',
    floor: '—', volume: '—', items: '1', change: '—', description: 'An individual NFT minted directly to its creator’s wallet.',
  }
  return collections.find((collection) => collection.id === id) ?? {
    id, name: id || 'Collection details unavailable', symbol: '', creatorId: '', cover: '',
    floor: '—', volume: '—', items: '0', change: '—', description: '',
  }
}
