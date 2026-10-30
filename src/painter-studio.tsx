import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Button, Icon } from './ui'
import type { WalletCollection } from './lib/backend'
import { loadStudioDraft, saveStudioDraft } from './lib/studio-drafts'
import type { StudioMintInput, StudioMintSuccess } from './create-studio'
import { MintDetailsDialog } from './create-studio'
import { getStroke } from 'perfect-freehand'

type CanvasFormat = 'square' | 'portrait' | 'landscape' | 'mural'
const formats: Record<CanvasFormat, { label: string; width: number; height: number }> = {
  square: { label: 'Square canvas · 1:1', width: 1024, height: 1024 },
  portrait: { label: 'Portrait canvas · 3:4', width: 900, height: 1200 },
  landscape: { label: 'Landscape canvas · 4:3', width: 1200, height: 900 },
  mural: { label: 'Wide mural · 2.5:1', width: 1600, height: 640 },
}
type PainterDraft = { format: CanvasFormat; background: string; color: string; brushSize: number; brushStyle?: 'round' | 'marker' | 'dry'; brushOpacity?: number; stabilization?: number; mixColors?: string[]; mixAmounts?: number[]; artwork: Blob }
function dryBrushPattern(context: CanvasRenderingContext2D, color: string) {
  const tile = document.createElement('canvas'); tile.width = 52; tile.height = 52
  const brush = tile.getContext('2d')
  if (!brush) return color
  let seed = [...color].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 17)
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  for (let index = 0; index < 95; index += 1) { brush.globalAlpha = random() * 0.75 + 0.15; brush.fillStyle = color; brush.fillRect(random() * 52, random() * 52, random() * 2.5 + 0.5, random() * 2.5 + 0.5) }
  return context.createPattern(tile, 'repeat') ?? color
}

const brushPresets = [
  { label: 'Detail', size: 2 }, { label: 'Liner', size: 5 }, { label: 'Fine', size: 10 },
  { label: 'Medium', size: 22 }, { label: 'Broad', size: 44 }, { label: 'Large', size: 80 }, { label: 'Mural', size: 150 },
]

function mixPaintColors(colors: string[], amounts: number[]) {
  const total = colors.reduce((sum, _, index) => sum + Math.max(1, amounts[index] || 1), 0)
  const channels = [1, 3, 5].map((offset) => Math.round(colors.reduce((sum, color, index) => sum + parseInt(color.slice(offset, offset + 2), 16) * Math.max(1, amounts[index] || 1), 0) / total))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not export the painting')), 'image/png'))
}

export function PainterStudioPage({ collections, busy, error, success, onMint, onPostToFeed, onHome }: {
  collections: WalletCollection[]
  busy: boolean
  error: string
  success: StudioMintSuccess | null
  onMint: (draft: StudioMintInput) => Promise<void>
  onPostToFeed: (artwork: File, caption: string) => void
  onHome: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const strokePoints = useRef<number[][]>([])
  const strokeBase = useRef<ImageData | null>(null)
  const undoStack = useRef<ImageData[]>([])
  const redoStack = useRef<ImageData[]>([])
  const [format, setFormat] = useState<CanvasFormat>('landscape')
  const [background, setBackground] = useState('#ffffff')
  const [color, setColor] = useState('#17141d')
  const [brushSize, setBrushSize] = useState(18)
  const [mixColors, setMixColors] = useState(['#e74b3c', '#f4cf42'])
  const [mixAmounts, setMixAmounts] = useState([1, 1])
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush')
  const [brushStyle, setBrushStyle] = useState<'round' | 'marker' | 'dry'>('round')
  const [brushOpacity, setBrushOpacity] = useState(100)
  const [stabilization, setStabilization] = useState(55)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [draftStatus, setDraftStatus] = useState('')
  const [mintDetailsOpen, setMintDetailsOpen] = useState(false)
  const [mintDraft, setMintDraft] = useState<StudioMintInput | null>(null)
  const [traits, setTraits] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [restoredArtwork, setRestoredArtwork] = useState<Blob | null>(null)
  const [ready, setReady] = useState(false)
  const [localError, setLocalError] = useState('')
  const [undoCount, setUndoCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)
  const size = formats[format]

  useEffect(() => {
    let mounted = true
    void loadStudioDraft<PainterDraft>('painter').then((draft) => {
      if (!mounted || !draft) return
      if (draft.format in formats) setFormat(draft.format)
      setBackground(draft.background || '#ffffff')
      setColor(draft.color || '#17141d')
      setBrushSize(draft.brushSize || 18)
      setBrushStyle(draft.brushStyle ?? 'round')
      setBrushOpacity(draft.brushOpacity ?? 100)
      setStabilization(draft.stabilization ?? 55)
      if (draft.mixColors && draft.mixColors.length >= 2) setMixColors(draft.mixColors.slice(0, 5))
      if (draft.mixAmounts && draft.mixAmounts.length >= 2) setMixAmounts(draft.mixAmounts.slice(0, 5))
      setRestoredArtwork(draft.artwork)
      setDraftStatus('Restored your saved painting.')
    }).catch(() => {}).finally(() => { if (mounted) setReady(true) })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !ready) return
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.fillStyle = background
    context.fillRect(0, 0, canvas.width, canvas.height)
    if (restoredArtwork) {
      const image = new Image()
      const url = URL.createObjectURL(restoredArtwork)
      image.onload = () => { context.drawImage(image, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url); setRestoredArtwork(null) }
      image.onerror = () => URL.revokeObjectURL(url)
      image.src = url
    }
  // Canvas is initialized after restoring a local draft; drawing state changes do not repaint it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, format])

  useEffect(() => { if (success) setMintDetailsOpen(false) }, [success])

  const pointFrom = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * (event.currentTarget.width / rect.width), y: (event.clientY - rect.top) * (event.currentTarget.height / rect.height) }
  }
  const remember = () => {
    const context = canvasRef.current?.getContext('2d')
    if (!context || !canvasRef.current) return
    undoStack.current = [...undoStack.current.slice(-14), context.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height)]
    redoStack.current = []
    setUndoCount(undoStack.current.length); setRedoCount(0)
  }
  const beginStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    remember()
    drawing.current = true
    const point = pointFrom(event)
    strokePoints.current = [[point.x, point.y, event.pressure || 0.5]]
    strokeBase.current = event.currentTarget.getContext('2d')?.getImageData(0, 0, event.currentTarget.width, event.currentTarget.height) ?? null
    renderStroke(event.currentTarget)
  }
  const continueStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !strokeBase.current) return
    const point = pointFrom(event)
    strokePoints.current.push([point.x, point.y, event.pressure || 0.5])
    renderStroke(event.currentTarget)
  }
  const renderStroke = (canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')
    if (!context || !strokeBase.current) return
    context.putImageData(strokeBase.current, 0, 0)
    const options = { size: brushSize, thinning: brushStyle === 'marker' ? 0.05 : brushStyle === 'dry' ? 0.75 : 0.45, smoothing: 0.72, streamline: stabilization / 100, simulatePressure: true, last: false }
    const outline = getStroke(strokePoints.current, options)
    if (outline.length < 3) return
    context.save()
    context.globalAlpha = brushOpacity / 100
    context.fillStyle = tool === 'eraser' ? background : brushStyle === 'dry' ? dryBrushPattern(context, color) : color
    context.beginPath(); context.moveTo(outline[0][0], outline[0][1])
    for (let index = 1; index < outline.length; index += 1) context.lineTo(outline[index][0], outline[index][1])
    context.closePath(); context.fill()
    context.restore()
  }
  const endStroke = (event?: PointerEvent<HTMLCanvasElement>) => {
    if (drawing.current && event?.currentTarget && strokeBase.current) {
      const context = event.currentTarget.getContext('2d')
      if (context) {
        context.putImageData(strokeBase.current, 0, 0)
        const outline = getStroke(strokePoints.current, { size: brushSize, thinning: brushStyle === 'marker' ? 0.05 : brushStyle === 'dry' ? 0.75 : 0.45, smoothing: 0.72, streamline: stabilization / 100, simulatePressure: true, last: true })
        if (outline.length >= 3) { context.save(); context.globalAlpha = brushOpacity / 100; context.fillStyle = tool === 'eraser' ? background : brushStyle === 'dry' ? dryBrushPattern(context, color) : color; context.beginPath(); context.moveTo(outline[0][0], outline[0][1]); for (let index = 1; index < outline.length; index += 1) context.lineTo(outline[index][0], outline[index][1]); context.closePath(); context.fill(); context.restore() }
      }
    }
    drawing.current = false; strokePoints.current = []; strokeBase.current = null
  }
  const undo = () => {
    const canvas = canvasRef.current; const context = canvas?.getContext('2d'); const last = undoStack.current.pop()
    if (!canvas || !context || !last) return
    redoStack.current.push(context.getImageData(0, 0, canvas.width, canvas.height)); context.putImageData(last, 0, 0)
    setUndoCount(undoStack.current.length); setRedoCount(redoStack.current.length)
  }
  const redo = () => {
    const canvas = canvasRef.current; const context = canvas?.getContext('2d'); const next = redoStack.current.pop()
    if (!canvas || !context || !next) return
    undoStack.current.push(context.getImageData(0, 0, canvas.width, canvas.height)); context.putImageData(next, 0, 0)
    setUndoCount(undoStack.current.length); setRedoCount(redoStack.current.length)
  }
  const changeFormat = (next: CanvasFormat) => {
    if (next === format) return
    if (!window.confirm('Changing the canvas format clears the current painting. Save your draft first if you want to keep it. Continue?')) return
    undoStack.current = []; redoStack.current = []; setUndoCount(0); setRedoCount(0); setRestoredArtwork(null); setFormat(next); setDraftStatus('')
  }
  const changeBackground = (next: string) => {
    const canvas = canvasRef.current; const context = canvas?.getContext('2d')
    if (canvas && context) {
      const painted = document.createElement('canvas'); painted.width = canvas.width; painted.height = canvas.height
      painted.getContext('2d')?.drawImage(canvas, 0, 0)
      context.fillStyle = next; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(painted, 0, 0)
    }
    setBackground(next)
  }
  const clearCanvas = () => {
    const canvas = canvasRef.current; const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    remember(); context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height)
  }
  const importImage = (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setLocalError('Choose an image file to use as a painting reference.'); return }
    const canvas = canvasRef.current; const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    remember(); setLocalError('')
    const image = new Image(); const url = URL.createObjectURL(file)
    image.onload = () => {
      context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height)
      const scale = Math.min(canvas.width / image.width, canvas.height / image.height)
      const width = image.width * scale; const height = image.height * scale
      context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height); URL.revokeObjectURL(url)
    }
    image.onerror = () => { URL.revokeObjectURL(url); setLocalError('Could not open that reference image.') }
    image.src = url
  }
  const saveDraft = async () => {
    if (!canvasRef.current) return
    setDraftStatus('Saving painting…')
    try {
      const artwork = await canvasBlob(canvasRef.current)
      await saveStudioDraft('painter', { format, background, color, brushSize, brushStyle, brushOpacity, stabilization, mixColors, mixAmounts, artwork } satisfies PainterDraft)
      setDraftStatus('Painting saved on this device. Reopen Painter & Mural Studio to continue.')
    } catch { setDraftStatus('Could not save the painting on this device.') }
  }
  const exportArtwork = async () => {
    setLocalError('')
    if (!canvasRef.current) throw new Error('Painting canvas is not ready')
    return new File([await canvasBlob(canvasRef.current)], `${(title.trim() || 'painting').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, { type: 'image/png' })
  }
  const postArtwork = async () => {
    try { onPostToFeed(await exportArtwork(), [title.trim(), description.trim()].filter(Boolean).join('\n\n') || 'Original painting created in StellaNova Painter & Mural Studio') }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Could not prepare this painting for the feed') }
  }
  const prepareMint = async () => {
    try { setMintDraft({ title: title.trim(), description, traits, artwork: await exportArtwork(), animation: null, collectionId, provenanceSource: 'painter-studio' }); setMintDetailsOpen(true) }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Could not prepare this painting for minting') }
  }
  const confirmMint = () => {
    if (!mintDraft) return
    void onMint({ ...mintDraft, title: title.trim(), description, traits, collectionId })
  }
  const mixedColor = mixPaintColors(mixColors, mixAmounts)
  const updateMixColor = (index: number, value: string) => setMixColors((items) => items.map((item, itemIndex) => itemIndex === index ? value : item))
  const updateMixAmount = (index: number, value: number) => setMixAmounts((items) => items.map((item, itemIndex) => itemIndex === index ? value : item))
  const addMixColor = () => { if (mixColors.length < 5) { setMixColors((items) => [...items, color]); setMixAmounts((items) => [...items, 1]) } }
  const removeMixColor = (index: number) => { if (mixColors.length > 2) { setMixColors((items) => items.filter((_, itemIndex) => itemIndex !== index)); setMixAmounts((items) => items.filter((_, itemIndex) => itemIndex !== index)) } }
  return <main className="creator-studio-page painter-studio-page">
    <header className="creator-studio-heading"><button className="back-link" onClick={onHome}><Icon name="arrow" size={15} /> Studios</button><span className="eyebrow">PAINTER & MURAL STUDIO</span><h1>Paint here. Make it yours.</h1><p>A canvas for painting and mural work. Choose your surface, brush and color, then save, share to the feed, or mint your finished piece on Stellar.</p></header>
    {success && <div className="studio-success" role="status"><img src={success.image} alt={success.title} /><div><span className="eyebrow">MINT CONFIRMED</span><h2>{success.title}</h2><p>Token #{success.tokenId} was minted on Stellar.</p></div></div>}
    <div className="painter-editor-layout"><section className="painter-editor">
      <div className="painter-editor-toolbar"><label><span>Surface</span><select value={format} onChange={(event) => changeFormat(event.target.value as CanvasFormat)}>{Object.entries(formats).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label><div className="painter-tool-buttons"><button type="button" className={tool === 'brush' ? 'is-active' : ''} onClick={() => setTool('brush')}>✎ Brush</button><button type="button" className={tool === 'eraser' ? 'is-active' : ''} onClick={() => setTool('eraser')}>▱ Eraser</button></div><label>Brush style<select value={brushStyle} onChange={(event) => setBrushStyle(event.target.value as typeof brushStyle)}><option value="round">Paint · smooth</option><option value="marker">Marker · even</option><option value="dry">Dry brush · textured edge</option></select></label><label className="painter-brush-size"><span>Brush size · {brushSize}px</span><input type="range" min="1" max="240" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /></label><label><span>Opacity · {brushOpacity}%</span><input type="range" min="5" max="100" value={brushOpacity} onChange={(event) => setBrushOpacity(Number(event.target.value))} /></label><label><span>Stroke smoothing · {stabilization}%</span><input type="range" min="0" max="95" value={stabilization} onChange={(event) => setStabilization(Number(event.target.value))} /></label>{brushPresets.map((preset) => <button type="button" key={preset.label} className={brushSize === preset.size ? 'is-active' : ''} aria-pressed={brushSize === preset.size} onClick={() => setBrushSize(preset.size)}>{preset.label} · {preset.size}px</button>)}<button type="button" disabled={!undoCount} onClick={undo}>Undo</button><button type="button" disabled={!redoCount} onClick={redo}>Redo</button><button type="button" onClick={clearCanvas}>Clear</button></div>
      <div className="painter-canvas-wrap" style={{ aspectRatio: `${size.width}/${size.height}` }}><canvas ref={canvasRef} width={size.width} height={size.height} onPointerDown={beginStroke} onPointerMove={continueStroke} onPointerUp={endStroke} onPointerCancel={endStroke} aria-label="Painting canvas" /></div>
      <div className="painter-palette"><label className="painter-color"><span>Paint color</span><input type="color" value={color} onChange={(event) => { setColor(event.target.value); setTool('brush') }} /></label><label className="painter-color"><span>Surface color</span><input type="color" value={background} onChange={(event) => changeBackground(event.target.value)} /></label><label className="painter-import"><span>Import a reference image</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { importImage(event.target.files?.[0]); event.currentTarget.value = '' }} /></label></div>
      <section className="painter-mixer" aria-labelledby="painter-mixer-title"><div className="painter-mixer__heading"><div><h2 id="painter-mixer-title">Mix paint</h2><p>Blend two or more colors, then use the result on your brush.</p></div><button type="button" onClick={addMixColor} disabled={mixColors.length >= 5}>+ Add color</button></div><div className="painter-mixer__wells">{mixColors.map((mixColor, index) => <div className="painter-mixer__well" key={index}><label><span>Color {index + 1}</span><input aria-label={`Mix color ${index + 1}`} type="color" value={mixColor} onChange={(event) => updateMixColor(index, event.target.value)} /></label><label><span>Amount · {mixAmounts[index]} parts</span><input aria-label={`Amount of color ${index + 1}`} type="range" min="1" max="10" value={mixAmounts[index]} onChange={(event) => updateMixAmount(index, Number(event.target.value))} /></label>{mixColors.length > 2 && <button type="button" onClick={() => removeMixColor(index)} aria-label={`Remove color ${index + 1}`}>Remove</button>}</div>)}</div><div className="painter-mixer__result"><span className="painter-mixer__swatch" style={{ background: mixedColor }} aria-label={`Mixed color ${mixedColor}`} /><div><b>Mixed color</b><small>{mixedColor.toUpperCase()} · digital color blend</small></div><button type="button" onClick={() => { setColor(mixedColor); setTool('brush') }}>Use this color</button></div><small className="painter-mixer__note">Digital color blending is an on-screen approximation; real paint results vary by pigment and medium.</small></section>
    </section><aside className="painter-work-panel"><span className="eyebrow">YOUR PAINTING</span><label className="create-modal__field"><span>Title</span><input className="offer-input" maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Name your work" /></label><label className="create-modal__field"><span>Description</span><textarea className="offer-input" rows={4} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Tell people about this painting or mural." /></label><Button variant="outline" onClick={() => void saveDraft()} disabled={!ready}>Save for later</Button>{draftStatus && <small role="status">{draftStatus}</small>}<Button variant="outline" onClick={() => void postArtwork()} disabled={!ready || !title.trim()}>Post painting to feed <Icon name="arrow" size={14} /></Button><Button onClick={() => void prepareMint()} disabled={!ready || !title.trim() || busy}>Mint as NFT <Icon name="arrow" size={14} /></Button>{(localError || error) && <p className="studio-error" role="alert">{localError || error}</p>}<small className="painter-note">Your drawing stays a regular digital artwork until you post it or choose to mint it as an NFT.</small></aside></div>
    {mintDetailsOpen && mintDraft && <MintDetailsDialog collections={collections} title={title} setTitle={setTitle} description={description} setDescription={setDescription} traits={traits} setTraits={setTraits} collectionId={collectionId} setCollectionId={setCollectionId} busy={busy} error={error} onClose={() => setMintDetailsOpen(false)} onConfirm={confirmMint} />}
  </main>
}
