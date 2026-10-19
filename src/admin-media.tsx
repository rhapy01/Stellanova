import { useEffect, useRef, useState } from 'react'
import { Button, Icon, Meta } from './ui'
import type { StellarWallet } from './lib/stellar'
import { getMediaHealth, getMediaProviders, uploadMedia, uploadMetadata, type MediaHealth, type MediaProviders, type MediaUploadResult } from './lib/media'
import { registerTokenCollection } from './lib/backend'
import type { NFT } from './data'

type MediaAdminTab = 'status' | 'upload' | 'metadata'

export function MediaAdmin({
  wallet,
}: {
  wallet: StellarWallet | null
}) {
  const [tab, setTab] = useState<MediaAdminTab>('status')
  const [providers, setProviders] = useState<MediaProviders | null>(null)
  const [health, setHealth] = useState<MediaHealth | null>(null)
  const [uploadToken, setUploadToken] = useState(() => window.localStorage.getItem('nftgram:upload-token') ?? '')
  const [lastResult, setLastResult] = useState<MediaUploadResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [collection, setCollection] = useState('unfiled')

  const [metaTokenId, setMetaTokenId] = useState('')
  const [metaName, setMetaName] = useState('')
  const [metaDesc, setMetaDesc] = useState('')
  const [metaImage, setMetaImage] = useState('')
  const [metaResult, setMetaResult] = useState<{ key: string; url: string | null; sha256: string } | null>(null)

  const [regTokenId, setRegTokenId] = useState('')
  const [regCollection, setRegCollection] = useState('')
  const [regStatus, setRegStatus] = useState('')

  const saveToken = (token: string) => {
    setUploadToken(token)
    window.localStorage.setItem('nftgram:upload-token', token)
  }

  const refreshStatus = async () => {
    const [p, h] = await Promise.all([getMediaProviders(), getMediaHealth()])
    setProviders(p)
    setHealth(h)
  }

  useEffect(() => { void refreshStatus() }, [])

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) { setStatusMsg('Select a file first'); return }
    if (!uploadToken) { setStatusMsg('Enter an upload authorization token'); return }

    setBusy(true)
    setStatusMsg(`Uploading ${file.name}…`)
    setLastResult(null)

    try {
      const result = await uploadMedia(file, collection || undefined, { uploadToken })
      setLastResult(result)
      setStatusMsg(`Uploaded successfully — SHA256: ${result.sha256.slice(0, 16)}…`)
      if (metaTokenId) setMetaImage(result.original.r2Url ?? result.original.cloudinaryUrl ?? '')
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  const handleRegisterCollection = async () => {
    if (!regTokenId || !regCollection) { setRegStatus('Enter a token ID and collection'); return }
    if (!wallet) { setRegStatus('Connect a wallet first (owner registration is enforced)'); return }
    setBusy(true)
    setRegStatus(`Registering token #${regTokenId} → ${regCollection}…`)
    try {
      await registerTokenCollection(wallet.address, regCollection, regTokenId)
      setRegStatus(`Registered token #${regTokenId} into ${regCollection} — subscribers will get drop alerts on mint.`)
    } catch (error) {
      setRegStatus(error instanceof Error ? error.message : 'Registration failed')
    } finally {
      setBusy(false)
    }
  }

  const handleMetadata = async () => {
    if (!metaTokenId || !metaName) { setStatusMsg('Token ID and name are required'); return }
    if (!uploadToken) { setStatusMsg('Enter an upload authorization token'); return }

    setBusy(true)
    setStatusMsg('Uploading metadata JSON to R2…')
    setMetaResult(null)

    try {
      const metadata = {
        name: metaName,
        description: metaDesc || `${metaName} — an StellaNova Edition.`,
        image: metaImage,
        attributes: [] as { trait_type: string; value: string }[],
      }
      const result = await uploadMetadata(metaTokenId, metadata, uploadToken)
      setMetaResult(result)
      setStatusMsg(`Metadata uploaded — key: ${result.key}`)
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : 'Metadata upload failed')
    } finally {
      setBusy(false)
    }
  }

  const tabActive = (t: MediaAdminTab) => tab === t ? 'is-active' : ''

  return (
    <div className="app-shell">
      <main className="main-content">
        <div className="page">
          <section className="page-heading page-heading--compact">
            <div>
              <span className="eyebrow">MEDIA STACK · ADMIN</span>
              <h1>Media<br /><i>management.</i></h1>
            </div>
            <button className="round-action" onClick={() => window.location.assign('/')} aria-label="Back to StellaNova">
              <Icon name="arrow" size={20} />
            </button>
          </section>

          {/* Auth token input */}
          <section className="section-block">
            <div className="section-title">
              <div>
                <span className="eyebrow">AUTHORIZATION</span>
                <h3>Upload token</h3>
              </div>
            </div>
            <p className="collection-description">
              The <code>NFTGRAM_MEDIA_UPLOAD_TOKEN</code> value set on the server. Stored locally.
            </p>
            <div className="purchase-intent">
              <div style={{ flex: 1 }}>
                <input
                  className="offer-input"
                  value={uploadToken}
                  onChange={(e) => saveToken(e.target.value)}
                  placeholder="Paste upload token…"
                  aria-label="Media upload authorization token"
                  style={{ width: '100%' }}
                />
              </div>
              <Button variant="quiet" onClick={() => { setUploadToken(''); window.localStorage.removeItem('nftgram:upload-token') }}>
                Clear
              </Button>
            </div>
            {health && (
              <div className="detail-meta" style={{ marginTop: 12 }}>
                <Meta label="Endpoint configured" value={health.configured ? '✅ Yes' : '❌ No'} />
                <Meta label="Cloudinary" value={health.cloudinary ? '✅ Enabled' : '⏸ Disabled'} />
                <Meta label="Cloudflare R2" value={health.cloudflare ? '✅ Enabled' : '⏸ Disabled'} />
                <Meta label="Auth configured" value={health.uploadAuthorization ? '✅ Yes' : '❌ No'} />
                {health.r2 && (
                  <Meta
                    label="R2 delivery domain"
                    value={health.r2.productionDomain ? `✅ Production · ${health.r2.baseUrl}` : health.r2.describesOnR2Dev ? '⚠️ Non-production r2.dev — attach a custom domain' : 'Not set'}
                  />
                )}
              </div>
            )}
          </section>

          {/* Tab bar */}
          <div className="market-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'status'} className={`market-tab ${tabActive('status')}`} onClick={() => setTab('status')}>
              Provider status
            </button>
            <button role="tab" aria-selected={tab === 'upload'} className={`market-tab ${tabActive('upload')}`} onClick={() => setTab('upload')}>
              Upload media
            </button>
            <button role="tab" aria-selected={tab === 'metadata'} className={`market-tab ${tabActive('metadata')}`} onClick={() => setTab('metadata')}>
              Metadata
            </button>
            <button className="market-tab" onClick={refreshStatus} style={{ marginLeft: 'auto' }}>
              <Icon name="activity" size={15} /> Refresh
            </button>
          </div>

          {/* Tab: Status */}
          {tab === 'status' && (
            <section className="section-block">
              <div className="section-title">
                <div>
                  <span className="eyebrow">PROVIDERS</span>
                  <h3>Media delivery stack</h3>
                </div>
              </div>
              {providers ? (
                <div className="detail-meta">
                  <Meta label="Canonical provider" value={providers.canonicalProvider ?? 'None configured'} />
                  <Meta label="Cloudflare R2" value={providers.cloudflare.enabled ? providers.cloudflare.publicBaseUrl ?? 'Enabled' : 'Disabled'} />
                  <Meta label="Cloudinary" value={providers.cloudinary.enabled ? providers.cloudinary.deliveryBaseUrl ?? 'Enabled' : 'Disabled'} />
                  <Meta label="R2 production domain" value={providers.cloudflare.onR2Dev ? '⚠️ Serving from r2.dev (dev only)' : providers.cloudflare.productionDomain ? '✅ Production custom domain' : providers.cloudflare.enabled ? 'Default domain' : 'N/A'} />
                </div>
              ) : (
                <p className="collection-description">Unable to reach the media status endpoint. Is the server running?</p>
              )}
              <p className="collection-description" style={{ marginTop: 16 }}>
                <strong>Architecture note:</strong> Per the media architecture document, originals are uploaded to both
                Cloudflare R2 (immutable object storage) and Cloudinary (rich transformation workflow)
                simultaneously. Token metadata JSON is stored only on R2 as the canonical source of truth.
              </p>
            </section>
          )}

          {/* Tab: Upload */}
          {tab === 'upload' && (
            <section className="section-block">
              <div className="section-title">
                <div>
                  <span className="eyebrow">UPLOAD</span>
                  <h3>Upload new media</h3>
                </div>
              </div>
              <p className="collection-description">
                Upload an image, video, or file. It will be sent to both Cloudflare R2 and Cloudinary.
                Max file size: 25 MB.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#666' }}>
                  Collection slug (for key naming)
                  <input
                    className="offer-input"
                    value={collection}
                    onChange={(e) => setCollection(e.target.value)}
                    placeholder="Collection slug"
                    style={{ marginTop: 4, width: '100%' }}
                  />
                </label>

                <div
                  className="art-card__image"
                  style={{
                    minHeight: 120,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                  onClick={() => fileRef.current?.click()}
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*,video/*,audio/*,.glb,.gltf,.json"
                    style={{ display: 'none' }}
                    onChange={() => setStatusMsg('')}
                  />
                  <span style={{ opacity: 0.5, textAlign: 'center' }}>
                    <Icon name="plus" size={24} /><br />
                    Click to select a file
                  </span>
                </div>

                {fileRef.current?.files?.[0] && (
                  <p style={{ fontSize: 13, color: '#888' }}>
                    Selected: {fileRef.current.files[0].name} ({(fileRef.current.files[0].size / 1024 / 1024).toFixed(2)} MB)
                  </p>
                )}

                <Button onClick={handleUpload} disabled={busy}>
                  {busy ? 'Uploading…' : 'Upload to R2 + Cloudinary'} <Icon name="arrow" size={15} />
                </Button>
              </div>

              {lastResult && (
                <div className="detail-note" style={{ marginTop: 16 }}>
                  <Icon name="spark" size={16} />
                  <span>
                    <b>Upload result</b>
                    <small>
                      Key: {lastResult.key}<br />
                      SHA256: {lastResult.sha256}<br />
                      Size: {(lastResult.bytes / 1024).toFixed(1)} KB<br />
                      Type: {lastResult.contentType}<br />
                      {lastResult.original.r2Url && <>R2: <a href={lastResult.original.r2Url} target="_blank" rel="noreferrer">{lastResult.original.r2Url.slice(0, 80)}…</a><br /></>}
                      {lastResult.original.cloudinaryUrl && <>Cloudinary: <a href={lastResult.original.cloudinaryUrl} target="_blank" rel="noreferrer">{lastResult.original.cloudinaryUrl.slice(0, 80)}…</a></>}
                    </small>
                  </span>
                </div>
              )}

              {statusMsg && !lastResult && (
                <div className="detail-note" style={{ marginTop: 16 }}>
                  <Icon name="activity" size={16} />
                  <span><b>Status</b><small>{statusMsg}</small></span>
                </div>
              )}
            </section>
          )}

          {/* Tab: Metadata */}
          {tab === 'metadata' && (
            <section className="section-block">
              <div className="section-title">
                <div>
                  <span className="eyebrow">METADATA</span>
                  <h3>Upload canonical metadata</h3>
                </div>
              </div>
              <p className="collection-description">
                Write SEP-50-compatible token metadata JSON to Cloudflare R2 as the canonical source.
                The <code>tokenURI</code> should point to this URL.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#666' }}>
                  Token ID
                  <input
                    className="offer-input"
                    value={metaTokenId}
                    onChange={(e) => setMetaTokenId(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="e.g. 0, 1, 2"
                    style={{ marginTop: 4, width: '100%' }}
                  />
                </label>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#666' }}>
                  Name
                  <input
                    className="offer-input"
                    value={metaName}
                    onChange={(e) => setMetaName(e.target.value)}
                    placeholder="e.g. Signal Drift 004"
                    style={{ marginTop: 4, width: '100%' }}
                  />
                </label>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#666' }}>
                  Description
                  <textarea
                    className="offer-input"
                    value={metaDesc}
                    onChange={(e) => setMetaDesc(e.target.value)}
                    placeholder="NFT description"
                    rows={3}
                    style={{ marginTop: 4, width: '100%', resize: 'vertical' }}
                  />
                </label>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#666' }}>
                  Image URL (upload first, then paste the R2 or Cloudinary URL)
                  <input
                    className="offer-input"
                    value={metaImage}
                    onChange={(e) => setMetaImage(e.target.value)}
                    placeholder="https://pub-xxxx.r2.dev/nftgram/originals/…"
                    style={{ marginTop: 4, width: '100%' }}
                  />
                </label>

                <Button onClick={handleMetadata} disabled={busy}>
                  {busy ? 'Uploading…' : 'Upload metadata JSON to R2'} <Icon name="arrow" size={15} />
                </Button>
              </div>

              {metaResult && (
                <div className="detail-note" style={{ marginTop: 16 }}>
                  <Icon name="spark" size={16} />
                  <span>
                    <b>Metadata uploaded</b>
                    <small>
                      Key: {metaResult.key}<br />
                      SHA256: {metaResult.sha256}<br />
                      {metaResult.url && <>URL: <a href={metaResult.url} target="_blank" rel="noreferrer">{metaResult.url.slice(0, 80)}…</a></>}
                    </small>
                  </span>
                </div>
              )}

              {statusMsg && !metaResult && (
                <div className="detail-note" style={{ marginTop: 16 }}>
                  <Icon name="activity" size={16} />
                  <span><b>Status</b><small>{statusMsg}</small></span>
                </div>
              )}
            </section>
          )}

          {/* Collection registration for drop alerts */}
          <section className="section-block">
            <div className="section-title">
              <div>
                <span className="eyebrow">DROP ALERTS</span>
                <h3>Register token to collection</h3>
              </div>
            </div>
            <p className="collection-description">
              Map a minted token to a collection so the indexer notifies that collection’s
              subscribers with a “new drop” alert when the token mints. Only the token owner can
              register it.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#666' }}>
                Token ID
                <input
                  className="offer-input"
                  value={regTokenId}
                  onChange={(e) => setRegTokenId(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="e.g. 0, 1, 2"
                  style={{ marginTop: 4, width: '100%' }}
                />
              </label>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#666' }}>
                Collection slug
                <input
                  className="offer-input"
                  value={regCollection}
                  onChange={(e) => setRegCollection(e.target.value)}
                  placeholder="Collection slug"
                  style={{ marginTop: 4, width: '100%' }}
                />
              </label>
              <Button onClick={handleRegisterCollection} disabled={busy}>
                {busy ? 'Registering…' : 'Register token to collection'} <Icon name="arrow" size={15} />
              </Button>
              {regStatus && (
                <div className="detail-note" style={{ marginTop: 4 }}>
                  <Icon name="activity" size={16} />
                  <span><b>Registration</b><small>{regStatus}</small></span>
                </div>
              )}
            </div>
          </section>

          {/* Preview section */}
          <section className="section-block">
            <div className="section-title">
              <div>
                <span className="eyebrow">PREVIEW</span>
                <h3>Token metadata template</h3>
              </div>
            </div>
            <pre
              style={{
                background: '#f5f5f5',
                padding: 16,
                borderRadius: 8,
                fontSize: 12,
                overflow: 'auto',
                maxHeight: 400,
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace',
              }}
            >
              {JSON.stringify(
                {
                  name: metaName || '<Token name>',
                  description: metaDesc || '<Description>',
                  image: metaImage || '<Media URL from upload step>',
                  attributes: [],
                  compiler: 'StellaNova Media Admin',
                },
                null,
                2,
              )}
            </pre>
          </section>
        </div>
      </main>
    </div>
  )
}
