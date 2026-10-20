import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { GifWriter } from 'omggif'
import type { WalletCollection } from './lib/backend'
import { loadStudioDraft, saveStudioDraft } from './lib/studio-drafts'
import { Avatar, Button, Icon } from './ui'

export type StudioMintInput = { title: string; description: string; traits: string; artwork: File; animation: File | null; collectionId: string; provenanceSource?: 'pixel-studio' | 'ai-studio' }
export type StudioMintSuccess = { tokenId: number; title: string; image: string; contractId: string; txHash: string; indexed?: boolean }
type SharedProps = { collections: WalletCollection[]; busy: boolean; error: string; success: StudioMintSuccess | null; onMint: (draft: StudioMintInput) => Promise<void>; onHome: () => void }

function MintDetails({ title, setTitle, description, setDescription, traits, setTraits, collectionId, setCollectionId, collections }: { title: string; setTitle: (value: string) => void; description: string; setDescription: (value: string) => void; traits: string; setTraits: (value: string) => void; collectionId: string; setCollectionId: (value: string) => void; collections: WalletCollection[] }) {
  return <section className="studio-fields"><span className="eyebrow">NFT DETAILS</span><label>Title<input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} placeholder="Name your artwork" /></label><label>Description<textarea value={description} maxLength={2000} rows={4} onChange={(event) => setDescription(event.target.value)} placeholder="What should collectors know about this piece?" /></label><label>Traits <small>One per line: name: value</small><textarea value={traits} rows={4} onChange={(event) => setTraits(event.target.value)} placeholder={'Background: Violet\nMood: Curious'} /></label><label>Mint to<select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}><option value="">Standalone NFT · your wallet</option>{collections.map((collection) => <option key={collection.slug} value={collection.slug}>{collection.name} · {collection.symbol}</option>)}</select><small>Choose one of your collections, or mint this as a standalone NFT.</small></label></section>
}

function MintDetailsDialog({ collections, title, setTitle, description, setDescription, traits, setTraits, collectionId, setCollectionId, busy, error, onClose, onConfirm }: { collections: WalletCollection[]; title: string; setTitle: (value: string) => void; description: string; setDescription: (value: string) => void; traits: string; setTraits: (value: string) => void; collectionId: string; setCollectionId: (value: string) => void; busy: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section className="studio-mint-dialog" role="dialog" aria-modal="true" aria-labelledby="studio-mint-title"><header><span className="eyebrow">READY TO MINT</span><button className="modal-close" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="close" size={18} /></button></header><h2 id="studio-mint-title">Add NFT details</h2><p>Your artwork is ready. Add its metadata and choose where to mint it.</p><MintDetails title={title} setTitle={setTitle} description={description} setDescription={setDescription} traits={traits} setTraits={setTraits} collectionId={collectionId} setCollectionId={setCollectionId} collections={collections} />{error && <p className="studio-error" role="alert">{error}</p>}<div className="studio-mint-dialog__actions"><Button variant="outline" onClick={onClose} disabled={busy}>Keep editing</Button><Button onClick={onConfirm} disabled={!title.trim() || busy}>{busy ? 'Minting on Stellar…' : 'Continue to mint'} <Icon name="arrow" size={15} /></Button></div></section></div>
}

function StudioSuccess({ success }: { success: StudioMintSuccess }) {
  const path = `/nft/minted-${success.contractId.toLowerCase()}-${success.tokenId}`
  const [copied, setCopied] = useState(false)
  const copyLink = async () => {
    const url = `${window.location.origin}${path}`
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1800) }
    catch { window.prompt('Copy NFT link', url) }
  }
  return <div className="studio-success" role="status"><img src={success.image} alt={success.title} /><div><span className="eyebrow">MINT CONFIRMED</span><h2>{success.title}</h2><p>Token #{success.tokenId} was minted on Stellar Testnet. {success.indexed ? 'It is now visible in the marketplace.' : 'Marketplace indexing is still finishing.'}</p><div><Button variant="outline" onClick={copyLink}><Icon name="share" size={15} />{copied ? 'Link copied' : 'Copy NFT link'}</Button><Button onClick={() => { window.location.assign(path) }}>View NFT <Icon name="arrow" size={14} /></Button></div></div></div>
}

function ArtworkPreview({ file }: { file: File }) {
  const [url, setUrl] = useState('')
  useEffect(() => { const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next) }, [file])
  return url ? <img src={url} alt="AI generated NFT preview" /> : <span>Loading preview…</span>
}

type PixelDraft = { size?: number; width?: number; height?: number; frames: number[][]; color: number; colors?: string[]; backgroundColor?: string; frameDelayMs?: number; fitArtwork?: boolean }
const defaultColors = ['#ffffff', '#17141d', '#eb4a68', '#ff9c38', '#f7da55', '#62bf61', '#35c7b4', '#3689ef', '#7554e9', '#d948c5', '#f2a8c6', '#9b6541', '#9298a5', '#a6d975', '#79dbeb', '#ffc16d']

type GifColor = { index: number; r: number; g: number; b: number; count: number }

function makeGifPalette(frames: number[][], colors: string[], backgroundColor: string) {
  const usage = new Map<number, number>()
  for (const frame of frames) for (const index of frame) if (index > 0) usage.set(index, (usage.get(index) ?? 0) + 1)
  const entries: GifColor[] = [...usage].map(([index, count]) => {
    const value = Number.parseInt((colors[index] ?? '#000000').slice(1), 16)
    return { index, r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, count }
  })
  const background = Number.parseInt(backgroundColor.slice(1), 16)
  const backgroundRgb = { r: (background >> 16) & 255, g: (background >> 8) & 255, b: background & 255 }
  if (entries.length <= 255) {
    const palette = [background, ...entries.map(({ r, g, b }) => (r << 16) | (g << 8) | b)]
    const indices = new Map(entries.map((entry, position) => [entry.index, position + 1]))
    return { palette, remap: (frame: number[]) => Uint8Array.from(frame, (index) => index === 0 ? 0 : indices.get(index) ?? 0) }
  }

  // GIF stores at most 256 palette entries. Keep the background in slot zero and
  // median-cut the artwork colors so the editor itself can still use full RGB.
  let boxes: GifColor[][] = [entries]
  while (boxes.length < 255) {
    let splitAt = -1
    let splitRange = -1
    let splitChannel: 'r' | 'g' | 'b' = 'r'
    boxes.forEach((box, boxIndex) => {
      if (box.length < 2) return
      const mins = [255, 255, 255]
      const maxs = [0, 0, 0]
      for (const color of box) {
        mins[0] = Math.min(mins[0], color.r); mins[1] = Math.min(mins[1], color.g); mins[2] = Math.min(mins[2], color.b)
        maxs[0] = Math.max(maxs[0], color.r); maxs[1] = Math.max(maxs[1], color.g); maxs[2] = Math.max(maxs[2], color.b)
      }
      const ranges = maxs.map((maximum, index) => maximum - mins[index])
      const range = Math.max(...ranges) * Math.log2(box.reduce((sum, color) => sum + color.count, 0) + 1)
      if (range > splitRange) { splitAt = boxIndex; splitRange = range; splitChannel = (['r', 'g', 'b'] as const)[ranges.indexOf(Math.max(...ranges))] }
    })
    if (splitAt < 0) break
    const box = boxes[splitAt].slice().sort((a, b) => a[splitChannel] - b[splitChannel])
    const half = box.reduce((sum, color) => sum + color.count, 0) / 2
    let weight = 0
    let cut = 1
    for (; cut < box.length; cut += 1) { weight += box[cut - 1].count; if (weight >= half) break }
    boxes.splice(splitAt, 1, box.slice(0, cut), box.slice(cut))
  }
  const representatives = boxes.map((box) => {
    const total = box.reduce((sum, color) => sum + color.count, 0)
    const r = Math.round(box.reduce((sum, color) => sum + color.r * color.count, 0) / total)
    const g = Math.round(box.reduce((sum, color) => sum + color.g * color.count, 0) / total)
    const b = Math.round(box.reduce((sum, color) => sum + color.b * color.count, 0) / total)
    return { r, g, b, value: (r << 16) | (g << 8) | b }
  })
  const indices = new Map<number, number>()
  entries.forEach((entry) => {
    let nearest = 0
    let distance = Infinity
    representatives.forEach((candidate, index) => {
      const dR = entry.r - candidate.r
      const dG = entry.g - candidate.g
      const dB = entry.b - candidate.b
      const nextDistance = dR * dR + dG * dG + dB * dB
      if (nextDistance < distance) { distance = nextDistance; nearest = index }
    })
    indices.set(entry.index, nearest + 1)
  })
  return { palette: [backgroundRgb.r << 16 | backgroundRgb.g << 8 | backgroundRgb.b, ...representatives.map((color) => color.value)], remap: (frame: number[]) => Uint8Array.from(frame, (index) => index === 0 ? 0 : indices.get(index) ?? 0) }
}

function paintPixel(canvas: HTMLCanvasElement, frame: number[], width: number, height: number, showGrid = true, colors: string[] = defaultColors, backgroundColor = '#ffffff') {
  const context = canvas.getContext('2d')
  if (!context) return
  const cellWidth = canvas.width / width
  const cellHeight = canvas.height / height
  context.fillStyle = backgroundColor; context.fillRect(0, 0, canvas.width, canvas.height)
  frame.forEach((color, index) => { if (color === 0) return; context.fillStyle = colors[color] ?? '#17141d'; context.fillRect(index % width * cellWidth, Math.floor(index / width) * cellHeight, cellWidth, cellHeight) })
  if (showGrid) {
    context.strokeStyle = 'rgba(32,25,40,.14)'; context.lineWidth = 1
    for (let x = 1; x < width; x += 1) { const point = x * cellWidth; context.beginPath(); context.moveTo(point, 0); context.lineTo(point, canvas.height); context.stroke() }
    for (let y = 1; y < height; y += 1) { const point = y * cellHeight; context.beginPath(); context.moveTo(0, point); context.lineTo(canvas.width, point); context.stroke() }
  }
}

function fitPixelFrames(frames: number[][], width: number, height: number, paddingRatio = 0.08) {
  let left = width, right = -1, top = height, bottom = -1
  frames.forEach((frame) => frame.forEach((pixel, index) => {
    if (!pixel) return
    const x = index % width, y = Math.floor(index / width)
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
  }))
  if (right < left || bottom < top) return { frames, width, height }
  const sourceWidth = right - left + 1, sourceHeight = bottom - top + 1
  const side = Math.max(width, height)
  const padding = Math.floor(side * paddingRatio)
  const scale = Math.max(1, Math.floor((side - padding * 2) / Math.max(sourceWidth, sourceHeight)))
  const fittedWidth = sourceWidth * scale, fittedHeight = sourceHeight * scale
  const offsetX = Math.floor((side - fittedWidth) / 2), offsetY = Math.floor((side - fittedHeight) / 2)
  const fitted = frames.map((frame) => {
    const pixels = Array(side * side).fill(0)
    for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) {
      const colorIndex = frame[y * width + x] ?? 0
      if (!colorIndex) continue
      for (let sy = 0; sy < scale; sy += 1) for (let sx = 0; sx < scale; sx += 1) {
        pixels[(offsetY + (y - top) * scale + sy) * side + offsetX + (x - left) * scale + sx] = colorIndex
      }
    }
    return pixels
  })
  return { frames: fitted, width: side, height: side }
}

function PixelFrameThumbnail({ frame, width, height, colors, backgroundColor }: { frame: number[]; width: number; height: number; colors: string[]; backgroundColor: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => { if (canvas.current) paintPixel(canvas.current, frame, width, height, false, colors, backgroundColor) }, [frame, width, height, colors, backgroundColor])
  return <canvas ref={canvas} width={width * 4} height={height * 4} aria-hidden="true" />
}

function PixelAnimationPreview({ frames, width, height, delayMs, playing, colors, backgroundColor }: { frames: number[][]; width: number; height: number; delayMs: number; playing: boolean; colors: string[]; backgroundColor: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [previewIndex, setPreviewIndex] = useState(0)
  useEffect(() => { setPreviewIndex(0) }, [frames.length])
  useEffect(() => {
    if (!playing || frames.length < 2) return
    const timer = window.setInterval(() => setPreviewIndex((index) => (index + 1) % frames.length), delayMs)
    return () => window.clearInterval(timer)
  }, [playing, frames.length, delayMs])
  useEffect(() => { if (canvas.current) paintPixel(canvas.current, frames[previewIndex] ?? frames[0] ?? [], width, height, false, colors, backgroundColor) }, [frames, previewIndex, width, height, colors, backgroundColor])
  return <canvas ref={canvas} width={width * 16} height={height * 16} aria-label="Animation preview" />
}

function canvasPoint(event: PointerEvent<HTMLCanvasElement>, width: number, height: number) {
  const box = event.currentTarget.getBoundingClientRect()
  const x = Math.max(0, Math.min(width - 1, Math.floor((event.clientX - box.left) / box.width * width)))
  const y = Math.max(0, Math.min(height - 1, Math.floor((event.clientY - box.top) / box.height * height)))
  return y * width + x
}

export function PixelStudioPage({ collections, busy, error, success, onMint, onHome }: SharedProps) {
  const [width, setWidth] = useState(32)
  const [height, setHeight] = useState(32)
  const [frames, setFrames] = useState<number[][]>(() => [Array(1024).fill(0)])
  const [frameIndex, setFrameIndex] = useState(0)
  const [color, setColor] = useState(1)
  const [colors, setColors] = useState<string[]>(defaultColors)
  const [backgroundColor, setBackgroundColor] = useState('#ffffff')
  const [fitArtwork, setFitArtwork] = useState(true)
  const [tool, setTool] = useState<'pencil' | 'eraser' | 'fill' | 'picker'>('pencil')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [traits, setTraits] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [playing, setPlaying] = useState(false)
  const [frameDelayMs, setFrameDelayMs] = useState(150)
  const [draftStatus, setDraftStatus] = useState('')
  const [draftReady, setDraftReady] = useState(false)
  const [mintDetailsOpen, setMintDetailsOpen] = useState(false)
  const [history, setHistory] = useState<{ frames: number[][]; index: number; width: number; height: number }[]>([])
  const [future, setFuture] = useState<{ frames: number[][]; index: number; width: number; height: number }[]>([])
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const active = frames[frameIndex] ?? []
  const artworkFrame = fitArtwork ? fitPixelFrames(frames, width, height) : { frames, width, height }

  useEffect(() => { if (success) setMintDetailsOpen(false) }, [success])
  useEffect(() => { let mounted = true; void loadStudioDraft<PixelDraft>('pixel').then((draft) => { if (!mounted || !draft) return; const legacySize = draft.size ?? 32; setWidth(draft.width ?? legacySize); setHeight(draft.height ?? legacySize); setFrames(draft.frames); setColor(Math.max(1, draft.color)); setColors(draft.colors?.length ? draft.colors : defaultColors); setBackgroundColor(draft.backgroundColor ?? '#ffffff'); setFrameDelayMs(draft.frameDelayMs ?? 150); setFitArtwork(draft.fitArtwork ?? true); setFrameIndex(0) }).catch(() => {}).finally(() => { if (mounted) setDraftReady(true) }); return () => { mounted = false } }, [])
  useEffect(() => { if (canvas.current) paintPixel(canvas.current, active, width, height, true, colors, backgroundColor) }, [active, width, height, colors, backgroundColor])

  const editPixel = (index: number) => {
    if (tool === 'picker') { if (active[index] > 0) setColor(active[index]); setTool('pencil'); return }
    setFrames((previous) => previous.map((pixels, itemIndex) => {
      if (itemIndex !== frameIndex) return pixels
      const nextColor = tool === 'eraser' ? 0 : color
      if (tool === 'fill') {
        const target = pixels[index]; if (target === nextColor) return pixels
        const next = pixels.slice(); const stack = [index]
        while (stack.length) { const cell = stack.pop()!; if (next[cell] !== target) continue; next[cell] = nextColor; const x = cell % width; const y = Math.floor(cell / width); if (x > 0) stack.push(cell - 1); if (x < width - 1) stack.push(cell + 1); if (y > 0) stack.push(cell - width); if (y < height - 1) stack.push(cell + width) }
        return next
      }
      if (pixels[index] === nextColor) return pixels
      const next = pixels.slice(); next[index] = nextColor; return next
    }))
  }
  const remember = () => { setHistory((items) => [...items.slice(-49), { frames: frames.map((pixels) => pixels.slice()), index: frameIndex, width, height }]); setFuture([]) }
  const undo = () => { const previous = history[history.length - 1]; if (!previous) return; setFuture((items) => [...items, { frames: frames.map((pixels) => pixels.slice()), index: frameIndex, width, height }]); setFrames(previous.frames); setFrameIndex(previous.index); setWidth(previous.width); setHeight(previous.height); setHistory((items) => items.slice(0, -1)) }
  const redo = () => { const next = future[future.length - 1]; if (!next) return; setHistory((items) => [...items, { frames: frames.map((pixels) => pixels.slice()), index: frameIndex, width, height }]); setFrames(next.frames); setFrameIndex(next.index); setWidth(next.width); setHeight(next.height); setFuture((items) => items.slice(0, -1)) }
  const changeSize = (value: string) => { const [nextWidth, nextHeight] = value.split('x').map(Number); if (window.confirm('Changing the grid will clear the current animation frames. Continue?')) { remember(); setWidth(nextWidth); setHeight(nextHeight); setFrames([Array(nextWidth * nextHeight).fill(0)]); setFrameIndex(0); setPlaying(false) } }
  const selectColor = (hex: string) => {
    const normalized = hex.toLowerCase()
    const existing = colors.findIndex((entry, index) => index > 0 && entry === normalized)
    if (existing >= 0) { setColor(existing); setTool('pencil'); return }
    setColors((current) => [...current, normalized]); setColor(colors.length); setTool('pencil')
  }
  const rotateFrames = () => {
    remember()
    setFrames((current) => current.map((frame) => {
      const rotated = Array(width * height).fill(0)
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rotated[x * height + (height - 1 - y)] = frame[y * width + x]
      return rotated
    }))
    setWidth(height); setHeight(width)
  }
  const addFrame = (duplicate: boolean) => { if (frames.length >= 30) return; remember(); const next = duplicate ? active.slice() : Array(width * height).fill(0); setFrames((current) => [...current, next]); setFrameIndex(frames.length); setPlaying(false) }
  const deleteFrame = () => { if (frames.length <= 1) { setFrames([Array(width * height).fill(0)]); setFrameIndex(0); return }; remember(); setFrames((current) => current.filter((_, index) => index !== frameIndex)); setFrameIndex((index) => Math.min(index, frames.length - 2)); setPlaying(false) }
  const saveDraft = async () => { setDraftStatus('Saving for later…'); try { await saveStudioDraft('pixel', { width, height, frames, color, colors, backgroundColor, frameDelayMs, fitArtwork } satisfies PixelDraft); setDraftStatus('Saved for later on this device. Reopen Pixel Studio to continue.') } catch { setDraftStatus('Could not save artwork for later on this device.') } }
  const mintDraft = async () => {
    if (!title.trim() || !draftReady) return
    const finalFrame = fitArtwork ? fitPixelFrames(frames, width, height) : { frames, width, height }
    const output = document.createElement('canvas'); output.width = finalFrame.width * 16; output.height = finalFrame.height * 16; paintPixel(output, finalFrame.frames[0], finalFrame.width, finalFrame.height, false, colors, backgroundColor)
    const png = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'))
    if (!png) return
    let animation: File | null = null
    if (frames.length > 1) {
      const buffer = new Uint8Array(Math.max(2048, finalFrame.width * finalFrame.height * frames.length * 8))
      const { palette: gifPalette, remap } = makeGifPalette(finalFrame.frames, colors, backgroundColor)
      const paletteSize = Math.max(2, 2 ** Math.ceil(Math.log2(gifPalette.length)))
      while (gifPalette.length < paletteSize) gifPalette.push(0xffffff)
      const writer = new GifWriter(buffer, finalFrame.width, finalFrame.height, { palette: gifPalette, loop: 0 })
      finalFrame.frames.forEach((pixels) => writer.addFrame(0, 0, finalFrame.width, finalFrame.height, remap(pixels), { delay: Math.max(2, Math.round(frameDelayMs / 10)), disposal: 2 }))
      animation = new File([buffer.slice(0, writer.end())], 'pixel-animation.gif', { type: 'image/gif' })
    }
    await onMint({ title: title.trim(), description, traits, artwork: new File([png], 'pixel-art.png', { type: 'image/png' }), animation, collectionId, provenanceSource: 'pixel-studio' })
  }
  const draftReadyToMint = Boolean(draftReady && frames.some((frame) => frame.some((pixel) => pixel !== 0)))

  return <main className="creator-studio-page">
    <header className="creator-studio-heading"><button className="back-link" onClick={onHome}><Icon name="arrow" size={15} /> Create</button><span className="eyebrow">PIXEL STUDIO · {frames.length > 1 ? 'ANIMATED ARTWORK' : 'STATIC OR ANIMATED ARTWORK'}</span><h1>Make it pixel by pixel.</h1><p>Draw, animate, and save your artwork. Add NFT details when you are ready to mint.</p></header>
    {success && <StudioSuccess success={success} />}
    <div className="pixel-studio-layout"><section className="pixel-studio-editor">
      <div className="pixel-studio-toolbar"><div className="pixel-studio-tools">{(['pencil', 'eraser', 'fill', 'picker'] as const).map((item) => <button key={item} className={tool === item ? 'is-active' : ''} onClick={() => setTool(item)} aria-label={item} title={item}>{item === 'pencil' ? '✎' : item === 'eraser' ? '▱' : item === 'fill' ? '▨' : '◉'}<span>{item}</span></button>)}</div><label className="pixel-size-control">Grid <select value={`${width}x${height}`} onChange={(event) => changeSize(event.target.value)}><option value="16x16">16 × 16 · square</option><option value="32x32">32 × 32 · square</option><option value="64x64">64 × 64 · square</option><option value="64x32">64 × 32 · landscape</option><option value="96x48">96 × 48 · landscape</option><option value="128x64">128 × 64 · landscape</option><option value="128x32">128 × 32 · wide lettering</option></select></label><button disabled={!history.length} onClick={undo}>Undo</button><button disabled={!future.length} onClick={redo}>Redo</button><button onClick={rotateFrames}>Rotate all 90°</button><button onClick={() => { remember(); setFrames((items) => items.map((pixels, index) => index === frameIndex ? Array(width * height).fill(0) : pixels)) }}>Clear frame</button></div>
      <div className="pixel-studio-canvas-wrap" style={{ aspectRatio: `${width} / ${height}` }}><canvas ref={canvas} width={width * 16} height={height * 16} onPointerDown={(event) => { drawing.current = true; event.currentTarget.setPointerCapture(event.pointerId); if (tool !== 'picker') remember(); editPixel(canvasPoint(event, width, height)) }} onPointerMove={(event) => { if (drawing.current && tool !== 'fill' && tool !== 'picker') editPixel(canvasPoint(event, width, height)) }} onPointerUp={() => { drawing.current = false }} onPointerCancel={() => { drawing.current = false }} aria-label={`Pixel art frame ${frameIndex + 1}`} /></div>
      <div className="pixel-studio-bottom"><div className="pixel-color-controls"><div className="pixel-color-picker"><label htmlFor="pixel-color-picker">Pixel color</label><input id="pixel-color-picker" type="color" value={colors[color] ?? '#17141d'} onChange={(event) => selectColor(event.target.value)} /><span>{colors[color]?.toUpperCase() ?? '#17141D'}</span></div><div className="pixel-color-picker"><label htmlFor="pixel-background-picker">Background</label><input id="pixel-background-picker" type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value)} /><span>{backgroundColor.toUpperCase()}</span></div></div>
        <div className="pixel-frame-strip"><div className="pixel-frame-strip__head"><b>{frames.length === 1 ? 'Static artwork' : 'Animation frames'} <small>{frames.length}/30</small></b><span>Frame {frameIndex + 1}</span><label>Delay<select value={frameDelayMs} onChange={(event) => setFrameDelayMs(Number(event.target.value))} disabled={frames.length < 2}><option value={50}>50 ms</option><option value={100}>100 ms</option><option value={150}>150 ms</option><option value={200}>200 ms</option><option value={300}>300 ms</option><option value={500}>500 ms</option><option value={1000}>1 s</option></select></label></div>
          <div className="pixel-frame-strip__items">{frames.map((frame, index) => <button key={index} className={index === frameIndex ? 'is-active' : ''} onClick={() => setFrameIndex(index)} aria-label={`Edit frame ${index + 1}`}><PixelFrameThumbnail frame={frame} width={width} height={height} colors={colors} backgroundColor={backgroundColor} /><small>{index + 1}</small></button>)}<button className="pixel-frame-strip__add" onClick={() => addFrame(false)} disabled={frames.length >= 30} aria-label="Add blank frame">＋</button></div>
          <div className="pixel-frame-strip__actions">{frames.length === 1 && <button className="pixel-frame-strip__animate" onClick={() => addFrame(true)}>Animate this artwork</button>}{frames.length > 1 && <><button onClick={() => addFrame(true)} disabled={frames.length >= 30}>Duplicate frame</button><button onClick={() => deleteFrame()}>Delete frame</button><button onClick={() => setPlaying((value) => !value)}>{playing ? 'Pause preview' : '▶ Preview animation'}</button></>}</div>
        </div>
      </div>
    </section>
    <aside className="pixel-studio-sidebar"><div className="studio-actions"><b>{frames.length > 1 ? 'Animated artwork preview' : 'Static artwork preview'}</b><div className="pixel-animation-preview" style={{ aspectRatio: `${artworkFrame.width} / ${artworkFrame.height}` }}><PixelAnimationPreview frames={artworkFrame.frames} width={artworkFrame.width} height={artworkFrame.height} delayMs={frameDelayMs} playing={playing} colors={colors} backgroundColor={backgroundColor} /></div><label className="pixel-fit-option"><input type="checkbox" checked={fitArtwork} onChange={(event) => setFitArtwork(event.target.checked)} /> Fit drawing to artwork</label><small>{fitArtwork ? 'Empty canvas is trimmed across all frames and the drawing is centered with crisp pixel edges.' : 'Keep the full canvas dimensions in the minted artwork.'}</small><small>{frames.length === 1 ? 'This will mint as a static PNG. Choose “Animate this artwork” to add frames and mint a GIF.' : `${frames.length} frames will mint as an animated GIF at ${frameDelayMs} ms per frame.`}</small><Button variant="outline" onClick={() => void saveDraft()} disabled={!draftReady}>Save for later</Button>{draftStatus && <small role="status">{draftStatus}</small>}<Button disabled={!draftReadyToMint || busy} onClick={() => setMintDetailsOpen(true)}>{frames.length > 1 ? 'Mint animated NFT' : 'Mint static NFT'} <Icon name="arrow" size={15} /></Button>{error && <p className="studio-error" role="alert">{error}</p>}</div></aside></div>
    {mintDetailsOpen && <MintDetailsDialog collections={collections} title={title} setTitle={setTitle} description={description} setDescription={setDescription} traits={traits} setTraits={setTraits} collectionId={collectionId} setCollectionId={setCollectionId} busy={busy} error={error} onClose={() => setMintDetailsOpen(false)} onConfirm={() => void mintDraft()} />}
  </main>
}

type AiDraft = { prompt: string; artwork: Blob | null }
export function AiStudioPage({ collections, busy, error, success, onMint, onGenerate, onHome }: SharedProps & { onGenerate: (prompt: string) => Promise<File> }) {
  const [prompt, setPrompt] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [traits, setTraits] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [artwork, setArtwork] = useState<File | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const [draftStatus, setDraftStatus] = useState('')
  const [draftReady, setDraftReady] = useState(false)
  const [mintDetailsOpen, setMintDetailsOpen] = useState(false)
  useEffect(() => { if (success) setMintDetailsOpen(false) }, [success])
  useEffect(() => { let mounted = true; void loadStudioDraft<AiDraft>('ai').then((draft) => { if (!mounted || !draft) return; setPrompt(draft.prompt); if (draft.artwork) setArtwork(new File([draft.artwork], 'ai-artwork.png', { type: draft.artwork.type || 'image/png' })) }).catch(() => {}).finally(() => { if (mounted) setDraftReady(true) }); return () => { mounted = false } }, [])
  const createArtwork = async () => { setGenerating(true); setGenerateError(''); try { setArtwork(await onGenerate(prompt.trim())) } catch (generationError) { setGenerateError(generationError instanceof Error ? generationError.message : 'Could not generate artwork.') } finally { setGenerating(false) } }
  const saveDraft = async () => { setDraftStatus('Saving draft…'); try { await saveStudioDraft('ai', { prompt, artwork } satisfies AiDraft); setDraftStatus('Artwork draft saved on this device.') } catch { setDraftStatus('Could not save draft on this device.') } }
  const draft: StudioMintInput | null = artwork && draftReady ? { title: title.trim(), description, traits, artwork, animation: null, collectionId, provenanceSource: 'ai-studio' } : null
  return <main className="creator-studio-page"><header className="creator-studio-heading"><button className="back-link" onClick={onHome}><Icon name="arrow" size={15} /> Create</button><span className="eyebrow">AI ART STUDIO</span><h1>Imagine it. Make it yours.</h1><p>Generate and save artwork. Add NFT details when you are ready to mint.</p></header>{success && <StudioSuccess success={success} />}<div className="ai-studio-layout"><section className="ai-studio-creation"><label className="ai-studio-prompt"><span>Describe the artwork you want</span><textarea value={prompt} maxLength={1000} rows={5} onChange={(event) => setPrompt(event.target.value)} placeholder="A small glowing spacecraft drifting over a quiet violet ocean, intricate hand-painted details, square composition…" /><small>{prompt.length}/1,000 · Be specific about subject, mood, colors, and style.</small></label>{generateError && <p role="alert" className="studio-error">{generateError}</p>}<Button onClick={() => void createArtwork()} disabled={generating || prompt.trim().length < 8}>{generating ? 'Creating your artwork…' : artwork ? 'Generate another variation' : 'Generate artwork'} <Icon name="spark" size={15} /></Button>{artwork && <div className="ai-studio-preview"><ArtworkPreview file={artwork} /></div>}</section><aside className="ai-studio-sidebar"><div className="studio-actions"><Button variant="outline" onClick={() => void saveDraft()} disabled={!draftReady}>Save artwork draft</Button>{draftStatus && <small role="status">{draftStatus}</small>}<Button disabled={!draft} onClick={() => setMintDetailsOpen(true)}>Mint NFT <Icon name="arrow" size={15} /></Button><small>Mint details are added only when you choose to mint.</small>{error && <p className="studio-error" role="alert">{error}</p>}</div></aside></div>{mintDetailsOpen && draft && <MintDetailsDialog collections={collections} title={title} setTitle={setTitle} description={description} setDescription={setDescription} traits={traits} setTraits={setTraits} collectionId={collectionId} setCollectionId={setCollectionId} busy={busy} error={error} onClose={() => setMintDetailsOpen(false)} onConfirm={() => void onMint(draft)} />}</main>
}
