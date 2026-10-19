import { authHeaders } from './backend'

export type MediaProviders = {
  cloudinary: { enabled: boolean; deliveryBaseUrl: string | null }
  cloudflare: { enabled: boolean; publicBaseUrl: string | null; productionDomain: boolean; onR2Dev: boolean }
  canonicalProvider: string | null
  metadataProvider?: string | null
}

export type R2Readiness = {
  baseUrl: string | null
  productionDomain: boolean
  describesOnR2Dev: boolean
}

export type MediaHealth = {
  configured: boolean
  cloudinary: boolean
  cloudflare: boolean
  uploadAuthorization: boolean
  r2?: R2Readiness
}

export type MediaUploadResult = {
  sha256: string
  key: string
  original: { r2Url: string | null; cloudinaryUrl: string | null }
  contentType: string
  bytes: number
}

export type MetadataUploadResult = {
  key: string
  url: string | null
  sha256: string
}

/**
 * Fetch the current media provider status from the backend.
 * Returns null if the backend is unavailable.
 */
export async function getMediaProviders(): Promise<MediaProviders | null> {
  try {
    const response = await fetch('/api/media/providers')
    if (!response.ok) return null
    return response.json() as Promise<MediaProviders>
  } catch {
    return null
  }
}

/**
 * Fetch the media stack health from the backend.
 * Returns null if the backend is unavailable.
 */
export async function getMediaHealth(): Promise<MediaHealth | null> {
  try {
    const response = await fetch('/api/media/health')
    if (!response.ok) return null
    return response.json() as Promise<MediaHealth>
  } catch {
    return null
  }
}

/**
 * Upload a file to the configured media providers (Cloudflare R2 + Cloudinary).
 * Requires a valid upload token set on the server.
 *
 * @param file - The file blob to upload
 * @param collection - An optional collection slug for key naming
 * @returns The upload result with hashes and provider URLs
 */
export async function uploadMedia(
  file: File,
  collection?: string,
  authorization: { walletAddress?: string; uploadToken?: string } = {},
): Promise<MediaUploadResult> {
  const headers: Record<string, string> = {}
  if (authorization.walletAddress) Object.assign(headers, authHeaders(authorization.walletAddress))
  if (authorization.uploadToken) headers['x-nftgram-upload-token'] = authorization.uploadToken
  if (authorization.walletAddress && !headers.authorization) {
    throw new Error('Your wallet sign-in expired. Reconnect your Stellar wallet, then try the upload again.')
  }

  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const jsonHeaders = { ...headers, 'content-type': 'application/json' }
  const signatureResponse = await fetch('/api/media/upload-signature', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ fileName: file.name, contentType: file.type || 'application/octet-stream', bytes: file.size, sha256, collection }),
  })
  const signature = await signatureResponse.json().catch(() => null)
  if (!signatureResponse.ok || !signature) throw new Error(signature?.error ?? 'Unable to authorize media upload')

  const cloudinaryForm = new FormData()
  cloudinaryForm.append('file', file)
  cloudinaryForm.append('api_key', signature.apiKey)
  cloudinaryForm.append('timestamp', signature.timestamp)
  cloudinaryForm.append('folder', signature.folder)
  cloudinaryForm.append('public_id', signature.publicId)
  cloudinaryForm.append('signature', signature.signature)
  const cloudinaryResponse = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(signature.cloudName)}/auto/upload`, {
    method: 'POST',
    body: cloudinaryForm,
  })
  const cloudinaryAsset = await cloudinaryResponse.json().catch(() => null)
  if (!cloudinaryResponse.ok || !cloudinaryAsset?.secure_url) {
    throw new Error(cloudinaryAsset?.error?.message ?? 'Cloudinary media upload failed')
  }

  const response = await fetch('/api/media/upload-complete', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      collection: signature.collectionId,
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      bytes: file.size,
      sha256,
      cloudinaryUrl: cloudinaryAsset.secure_url,
    }),
  })

  if (!response.ok) {
    const error = (await response.json().catch(() => null))?.error ?? 'Media upload failed'
    throw new Error(error)
  }

  return response.json() as Promise<MediaUploadResult>
}

/** Upload immutable creator metadata JSON for direct mints and drop stages. */
export async function uploadCreatorMetadata(
  walletAddress: string,
  collection: string,
  metadata: Record<string, unknown>,
): Promise<MetadataUploadResult> {
  const response = await fetch('/api/creator/metadata', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(walletAddress) },
    body: JSON.stringify({ collection, metadata }),
  })
  if (!response.ok) {
    const error = (await response.json().catch(() => null))?.error ?? 'Metadata upload failed'
    throw new Error(error)
  }
  return response.json() as Promise<MetadataUploadResult>
}

/**
 * Upload canonical NFT metadata JSON to Cloudflare R2.
 * Requires a valid upload token set on the server.
 *
 * @param tokenId - The numeric token ID
 * @param metadata - The metadata object (will be JSON-stringified)
 * @returns The metadata key and URL
 */
export async function uploadMetadata(
  tokenId: number | string,
  metadata: Record<string, unknown>,
  uploadToken?: string,
): Promise<MetadataUploadResult> {
  const responseHeaders: Record<string, string> = { 'content-type': 'application/json' }
  if (uploadToken) responseHeaders['x-nftgram-upload-token'] = uploadToken

  const response = await fetch('/api/media/metadata', {
    method: 'POST',
    headers: responseHeaders,
    body: JSON.stringify({ tokenId: String(tokenId), metadata }),
  })

  if (!response.ok) {
    const error = (await response.json().catch(() => null))?.error ?? 'Metadata upload failed'
    throw new Error(error)
  }

  return response.json() as Promise<MetadataUploadResult>
}

/**
 * Build a Cloudinary delivery URL for a given public ID with optional transformations.
 * Only use when Cloudinary is the delivery provider.
 */
export function cloudinaryUrl(
  publicId: string,
  options: { width?: number; height?: number; quality?: number; format?: 'webp' | 'avif' | 'auto' } = {},
): string {
  const baseUrl = (import.meta.env.VITE_CLOUDINARY_DELIVERY_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? (import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ? `https://res.cloudinary.com/${import.meta.env.VITE_CLOUDINARY_CLOUD_NAME}/image/upload` : undefined)
  const transformations: string[] = ['f_auto', 'q_auto']
  if (options.width) transformations.push(`w_${options.width}`)
  if (options.height) transformations.push(`h_${options.height}`)
  if (options.format) transformations.push(`f_${options.format}`)
  if (options.quality) transformations.push(`q_${options.quality}`)
  return `${baseUrl}/${transformations.join(',')}/${publicId}`
}

/**
 * Build a Cloudflare R2 public URL for a given object key.
 * Only use when R2 is the delivery provider.
 */
export function r2Url(key: string): string {
  const baseUrl = (import.meta.env.VITE_CLOUDFLARE_R2_PUBLIC_BASE_URL as string | undefined)?.replace(/\/$/, '')
  if (!baseUrl) throw new Error('VITE_CLOUDFLARE_R2_PUBLIC_BASE_URL is not configured')
  return `${baseUrl}/${key.replace(/^\//, '')}`
}
