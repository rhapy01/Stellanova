import { useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, Circle, FabricImage, IText, Rect, Triangle, type FabricObject } from 'fabric'
import type { WalletCollection } from './lib/backend'
import { loadStudioDraft, saveStudioDraft } from './lib/studio-drafts'
import { Button, Icon } from './ui'
import { MintDetailsDialog, type StudioMintInput, type StudioMintSuccess } from './create-studio'

type Props = { collections: WalletCollection[]; busy: boolean; error: string; success: StudioMintSuccess | null; onMint: (draft: StudioMintInput) => Promise<void>; onPostToFeed: (artwork: File, caption: string) => void; onHome: () => void }
type Format = 'square' | 'portrait' | 'landscape' | 'story' | 'poster'
const formats: Record<Format, { label: string; width: number; height: number }> = {
  square: { label: 'Square post · 1080 × 1080', width: 1080, height: 1080 },
  portrait: { label: 'Portrait · 1080 × 1350', width: 1080, height: 1350 },
  landscape: { label: 'Landscape · 1600 × 900', width: 1600, height: 900 },
  story: { label: 'Story · 1080 × 1920', width: 1080, height: 1920 },
  poster: { label: 'Print poster · 2400 × 3600', width: 2400, height: 3600 },
}
type Draft = { version: 1; format: Format; json: object; background?: string; title: string; description: string; traits: string; collectionId: string }
const starterColors = ['#17141d', '#ffffff', '#e84886', '#7554e9', '#ff9b45', '#31a89a', '#f4cb55']

export function CollagePosterStudioPage({ collections, busy, error, success, onMint, onPostToFeed, onHome }: Props) {
  const element = useRef<HTMLCanvasElement>(null)
  const editor = useRef<Canvas | null>(null)
  const [format, setFormat] = useState<Format>('portrait')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [traits, setTraits] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('')
  const [localError, setLocalError] = useState('')
  const [selected, setSelected] = useState<FabricObject | null>(null)
  const [opacity, setOpacity] = useState(100)
  const [fill, setFill] = useState('#7554e9')
  const [background, setBackground] = useState('#ffffff')
  const [revision, setRevision] = useState(0)
  const [mintOpen, setMintOpen] = useState(false)
  const [mintDraft, setMintDraft] = useState<StudioMintInput | null>(null)
  const past = useRef<object[]>([])
  const future = useRef<object[]>([])
  const [historyCounts, setHistoryCounts] = useState({ past: 0, future: 0 })
  const dimensions = formats[format]
  const checkpoint = () => { const canvas = editor.current; if (!canvas) return; const snapshot = canvas.toJSON(); if (JSON.stringify(snapshot).length > 8_000_000) return; past.current = [...past.current.slice(-9), snapshot]; future.current = []; setHistoryCounts({ past: past.current.length, future: 0 }) }

  useEffect(() => {
    if (!element.current) return
    const canvas = new Canvas(element.current, { width: dimensions.width, height: dimensions.height, backgroundColor: '#ffffff', preserveObjectStacking: true, selection: true, enableRetinaScaling: true })
    editor.current = canvas
    const syncSelection = () => { const active = canvas.getActiveObject() ?? null; setSelected(active); setRevision((value) => value + 1); if (active) { setOpacity(Math.round((active.opacity ?? 1) * 100)); if (typeof active.fill === 'string') setFill(active.fill) } }
    canvas.on('selection:created', syncSelection); canvas.on('selection:updated', syncSelection); canvas.on('selection:cleared', syncSelection)
    canvas.on('object:modified', syncSelection); canvas.on('object:added', syncSelection); canvas.on('object:removed', syncSelection); canvas.on('text:changed', syncSelection)
    canvas.on('before:transform', checkpoint)
    let mounted = true
    void loadStudioDraft<Draft>('collage-poster').then(async (draft) => {
      if (!mounted || !draft || draft.version !== 1) return
      if (draft.format in formats) setFormat(draft.format)
      setTitle(draft.title ?? ''); setDescription(draft.description ?? ''); setTraits(draft.traits ?? ''); setCollectionId(draft.collectionId ?? ''); setBackground(draft.background ?? '#ffffff')
      await canvas.loadFromJSON(draft.json)
      if (mounted) { canvas.requestRenderAll(); setStatus('Restored your editable design.') }
    }).catch(() => {}).finally(() => { if (mounted) setReady(true) })
    return () => { mounted = false; editor.current = null; void canvas.dispose() }
  // Canvas is mounted once; draft and surface size are applied separately.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { const canvas = editor.current; if (!canvas) return; canvas.setDimensions({ width: dimensions.width, height: dimensions.height }); canvas.requestRenderAll() }, [format])
  useEffect(() => { if (success) setMintOpen(false) }, [success])
  useEffect(() => {
    const canvas = editor.current
    if (!canvas || !ready) return
    const timer = window.setTimeout(() => { void saveStudioDraft('collage-poster', { version: 1, format, json: canvas.toJSON(), background, title, description, traits, collectionId } satisfies Draft).then(() => setStatus('Saved on this device')).catch(() => setStatus('Autosave could not save this design')) }, 1200)
    return () => window.clearTimeout(timer)
  }, [ready, format, background, title, description, traits, collectionId, revision])

  const addText = () => { const canvas = editor.current; if (!canvas) return; checkpoint(); const text = new IText('Your headline', { left: 100, top: 120, width: dimensions.width * .72, fontFamily: 'Arial', fontSize: Math.round(dimensions.width * .075), fontWeight: 700, fill: '#17141d', lineHeight: 1.05, editable: true }); canvas.add(text); canvas.setActiveObject(text); canvas.requestRenderAll() }
  const addShape = (kind: 'rect' | 'circle' | 'triangle') => { const canvas = editor.current; if (!canvas) return; checkpoint(); const common = { left: dimensions.width * .28, top: dimensions.height * .3, fill, opacity, strokeUniform: true }; const shape = kind === 'rect' ? new Rect({ ...common, width: dimensions.width * .42, height: dimensions.width * .26, rx: 18, ry: 18 }) : kind === 'circle' ? new Circle({ ...common, radius: dimensions.width * .16 }) : new Triangle({ ...common, width: dimensions.width * .34, height: dimensions.width * .3 }); canvas.add(shape); canvas.setActiveObject(shape); canvas.requestRenderAll() }
  const importImage = async (file?: File) => { if (!file) return; setLocalError(''); if (!file.type.startsWith('image/')) { setLocalError('Choose an image file.'); return } if (file.size > 8 * 1024 * 1024) { setLocalError('Images must be 8 MB or smaller so editable history and drafts stay responsive.'); return } try { const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read that image')); reader.readAsDataURL(file) }); const image = await FabricImage.fromURL(dataUrl); const canvas = editor.current; if (!canvas) return; checkpoint(); const scale = Math.min(dimensions.width * .72 / (image.width || 1), dimensions.height * .56 / (image.height || 1)); image.set({ left: dimensions.width * .14, top: dimensions.height * .2, scaleX: scale, scaleY: scale, objectCaching: false }); canvas.add(image); canvas.setActiveObject(image); canvas.requestRenderAll() } catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Could not place that image') } }
  const updateSelected = (changes: Record<string, unknown>) => { const canvas = editor.current; if (!canvas || !selected) return; checkpoint(); selected.set(changes); selected.setCoords(); canvas.requestRenderAll(); setRevision((value) => value + 1) }
  const save = useCallback(async () => { const canvas = editor.current; if (!canvas) return; try { await saveStudioDraft('collage-poster', { version: 1, format, json: canvas.toJSON(), background, title, description, traits, collectionId } satisfies Draft); setStatus('Saved on this device') } catch { setStatus('Could not save this design') } }, [format, background, title, description, traits, collectionId])
  const exportArtwork = async () => { const canvas = editor.current; if (!canvas) throw new Error('Design canvas is not ready'); canvas.discardActiveObject(); canvas.requestRenderAll(); const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob({ format: 'png', multiplier: 1, enableRetinaScaling: false }).then((value) => value ? resolve(value) : reject(new Error('Could not export the design')))); return new File([blob], `${(title || 'poster-collage').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, { type: 'image/png' }) }
  const post = async () => { try { onPostToFeed(await exportArtwork(), [title.trim(), description.trim()].filter(Boolean).join('\n\n') || 'Designed in StellaNova Poster & Collage Studio') } catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Could not prepare the design') } }
  const prepareMint = async () => { try { setMintDraft({ title: title.trim(), description, traits, artwork: await exportArtwork(), animation: null, collectionId, provenanceSource: 'collage-studio' }); setMintOpen(true) } catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Could not prepare the design') } }
  const removeSelected = () => { if (!selected || !editor.current) return; checkpoint(); editor.current.remove(selected); editor.current.discardActiveObject(); setSelected(null); editor.current.requestRenderAll() }
  const duplicateSelected = () => { if (!selected || !editor.current) return; checkpoint(); void selected.clone().then((copy) => { copy.set({ left: (selected.left ?? 0) + 32, top: (selected.top ?? 0) + 32 }); editor.current?.add(copy); editor.current?.setActiveObject(copy); editor.current?.requestRenderAll() }) }
  const moveLayer = (direction: 'up' | 'down') => { if (!selected || !editor.current) return; checkpoint(); direction === 'up' ? editor.current.bringObjectForward(selected) : editor.current.sendObjectBackwards(selected); editor.current.requestRenderAll(); setRevision((value) => value + 1) }
  const alignSelected = (axis: 'horizontal' | 'vertical') => { const canvas = editor.current; if (!canvas || !selected) return; checkpoint(); if (axis === 'horizontal') selected.set('left', (canvas.getWidth() - selected.getScaledWidth()) / 2); else selected.set('top', (canvas.getHeight() - selected.getScaledHeight()) / 2); selected.setCoords(); canvas.requestRenderAll(); setRevision((value) => value + 1) }
  const applyTemplate = (kind: 'editorial' | 'event' | 'gallery') => {
    const canvas = editor.current; if (!canvas) return; checkpoint(); canvas.getObjects().slice().forEach((object) => canvas.remove(object))
    const w = canvas.getWidth(), h = canvas.getHeight()
    const accent = kind === 'editorial' ? '#e84886' : kind === 'event' ? '#7554e9' : '#31a89a'
    canvas.backgroundColor = kind === 'gallery' ? '#f4f0e8' : '#ffffff'; setBackground(kind === 'gallery' ? '#f4f0e8' : '#ffffff')
    const addTextBlock = (text: string, left: number, top: number, size: number, color: string, weight: number, font = 'Arial') => canvas.add(new IText(text, { left, top, width: w * .78, fontSize: size, fill: color, fontFamily: font, fontWeight: weight, lineHeight: 1.05 }))
    if (kind === 'editorial') {
      canvas.add(new Rect({ left: w * .08, top: h * .08, width: w * .12, height: 8, fill: accent, selectable: false, evented: false }))
      addTextBlock('THE\nBIG IDEA', w * .08, h * .2, w * .12, '#17141d', 700, 'Georgia')
      canvas.add(new Rect({ left: w * .08, top: h * .56, width: w * .84, height: h * .25, fill: '#f3e8ed', rx: 8, ry: 8 }))
      addTextBlock('ADD YOUR IMAGE', w * .13, h * .65, w * .06, '#756b72', 700)
      addTextBlock('A short supporting line', w * .08, h * .86, w * .042, '#605760', 400)
    } else if (kind === 'event') {
      canvas.add(new Rect({ left: 0, top: 0, width: w * .12, height: h, fill: accent, selectable: false, evented: false }))
      addTextBlock('A NIGHT TO\nREMEMBER', w * .2, h * .16, w * .105, '#17141d', 700, 'Georgia')
      canvas.add(new Circle({ left: w * .58, top: h * .48, radius: Math.min(w, h) * .13, fill: '#f2e9ff' }))
      addTextBlock('DATE  ·  TIME  ·  PLACE', w * .2, h * .78, w * .035, accent, 700)
      addTextBlock('Tickets and details', w * .2, h * .84, w * .03, '#605760', 400)
    } else {
      addTextBlock('OPEN\nSTUDIOS', w * .1, h * .08, w * .095, '#17141d', 700, 'Georgia')
      canvas.add(new Rect({ left: w * .1, top: h * .38, width: w * .8, height: h * .32, fill: '#d4c5b8', rx: 3, ry: 3 }))
      addTextBlock('ARTIST NAME', w * .1, h * .77, w * .04, '#17141d', 700)
      addTextBlock('Collection · Year', w * .1, h * .83, w * .03, '#605760', 400)
    }
    canvas.discardActiveObject(); canvas.requestRenderAll(); setSelected(null); setRevision((value) => value + 1)
  }
  const undo = async () => { const canvas = editor.current; const snapshot = past.current.pop(); if (!canvas || !snapshot) return; future.current.push(canvas.toJSON()); await canvas.loadFromJSON(snapshot); canvas.discardActiveObject(); setSelected(null); canvas.requestRenderAll(); setHistoryCounts({ past: past.current.length, future: future.current.length }); setRevision((value) => value + 1) }
  const redo = async () => { const canvas = editor.current; const snapshot = future.current.pop(); if (!canvas || !snapshot) return; past.current.push(canvas.toJSON()); await canvas.loadFromJSON(snapshot); canvas.discardActiveObject(); setSelected(null); canvas.requestRenderAll(); setHistoryCounts({ past: past.current.length, future: future.current.length }); setRevision((value) => value + 1) }
  const objects = editor.current?.getObjects() ?? []

  return <main className="creator-studio-page collage-studio-page">
    <header className="creator-studio-heading"><button className="back-link" onClick={onHome}><Icon name="arrow" size={15} /> Studios</button><span className="eyebrow">POSTER & COLLAGE STUDIO</span><h1>Compose a piece with layers.</h1><p>Build posters, social artwork and collages from placed images, editable type and shapes. Save your editable design, post it, or mint a finished export.</p></header>
    {success && <div className="studio-success" role="status"><img src={success.image} alt={success.title} /><div><span className="eyebrow">MINT CONFIRMED</span><h2>{success.title}</h2><p>Token #{success.tokenId} was minted on Stellar.</p></div></div>}
    <div className="collage-workspace"><section className="collage-editor">
      <div className="collage-toolbar"><label>Format<select value={format} onChange={(event) => setFormat(event.target.value as Format)}>{Object.entries(formats).map(([key, option]) => <option value={key} key={key}>{option.label}</option>)}</select></label><button type="button" onClick={() => applyTemplate('editorial')}>Editorial layout</button><button type="button" onClick={() => applyTemplate('event')}>Event poster</button><button type="button" onClick={() => applyTemplate('gallery')}>Gallery card</button><button type="button" onClick={undo} disabled={!historyCounts.past}>Undo</button><button type="button" onClick={redo} disabled={!historyCounts.future}>Redo</button><button type="button" onClick={addText}>Add text</button><button type="button" onClick={() => addShape('rect')}>Rectangle</button><button type="button" onClick={() => addShape('circle')}>Circle</button><button type="button" onClick={() => addShape('triangle')}>Triangle</button><label className="collage-upload">Add image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void importImage(event.target.files?.[0]); event.currentTarget.value = '' }} /></label></div>
      <div className="collage-canvas-scroll"><div className="collage-canvas-frame" style={{ aspectRatio: `${dimensions.width}/${dimensions.height}` }}><canvas ref={element} /></div></div>
      <div className="collage-colors" aria-label="Quick colors">{starterColors.map((value) => <button type="button" key={value} aria-label={`Set color ${value}`} style={{ background: value }} onClick={() => { setFill(value); updateSelected({ fill: value }) }} />)}<label>Custom<input type="color" value={fill} onChange={(event) => { setFill(event.target.value); updateSelected({ fill: event.target.value }) }} /></label><label>Canvas<input type="color" aria-label="Canvas background color" value={background} onChange={(event) => { const color = event.target.value; setBackground(color); if (editor.current) { editor.current.backgroundColor = color; editor.current.requestRenderAll(); setRevision((value) => value + 1) } }} /></label></div>
    </section>
    <aside className="collage-inspector"><div className="collage-inspector__head"><span className="eyebrow">DESIGN INSPECTOR</span><small role="status">{status || 'Autosaves on this device'}</small></div>
      {selected ? <><div className="collage-inspector__actions"><button type="button" onClick={() => moveLayer('up')}>Bring forward</button><button type="button" onClick={() => moveLayer('down')}>Send backward</button><button type="button" onClick={() => alignSelected('horizontal')}>Center horizontally</button><button type="button" onClick={() => alignSelected('vertical')}>Center vertically</button><button type="button" onClick={duplicateSelected}>Duplicate</button><button type="button" onClick={removeSelected}>Delete</button></div><label>Opacity · {opacity}%<input type="range" min="5" max="100" value={opacity} onChange={(event) => { const value = Number(event.target.value); setOpacity(value); updateSelected({ opacity: value / 100 }) }} /></label>{selected instanceof IText && <><label>Text content<textarea rows={3} value={selected.text ?? ''} onChange={(event) => { selected.set('text', event.target.value); editor.current?.requestRenderAll(); setRevision((value) => value + 1) }} /></label><label>Font size<input type="range" min="18" max="240" value={Number(selected.fontSize ?? 48)} onChange={(event) => updateSelected({ fontSize: Number(event.target.value) })} /></label><label>Typeface<select value={selected.fontFamily ?? 'Arial'} onChange={(event) => updateSelected({ fontFamily: event.target.value })}><option>Arial</option><option>Georgia</option><option>Impact</option><option>Trebuchet MS</option><option>Courier New</option></select></label><label><span>Text emphasis</span><select value={selected.fontWeight === 700 ? 'bold' : 'normal'} onChange={(event) => updateSelected({ fontWeight: event.target.value === 'bold' ? 700 : 400 })}><option value="normal">Regular</option><option value="bold">Bold</option></select></label><label><span>Text alignment</span><select value={selected.textAlign ?? 'left'} onChange={(event) => updateSelected({ textAlign: event.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label></>}</> : <p className="collage-empty-selection">Select an object on the canvas to edit its layer, opacity, color, or type.</p>}
      <div className="collage-layer-list"><b>Layers <small>{objects.length}</small></b>{objects.length ? [...objects].reverse().map((object, reversedIndex) => { const index = objects.length - 1 - reversedIndex; return <button type="button" key={`${index}-${object.type}`} className={selected === object ? 'is-active' : ''} onClick={() => { editor.current?.setActiveObject(object); editor.current?.requestRenderAll(); setSelected(object) }}><span>{object.type === 'i-text' ? (object as IText).text?.slice(0, 26) || 'Text' : object.type === 'image' ? 'Image' : object.type}</span><small>{index + 1}</small></button> }) : <small>Add text, images or shapes to begin.</small>}</div>
      <label>Artwork title<input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} placeholder="Name your design" /></label><label>Description<textarea rows={3} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe this piece" /></label>
      <div className="collage-publish"><Button variant="outline" onClick={() => void save()} disabled={!ready}>Save design</Button>{status && <small role="status">{status}</small>}<Button variant="outline" onClick={() => void post()} disabled={!ready}>Post to feed <Icon name="arrow" size={14} /></Button><Button onClick={() => void prepareMint()} disabled={!ready || !title.trim() || busy}>Mint artwork <Icon name="arrow" size={14} /></Button>{(localError || error) && <p className="studio-error" role="alert">{localError || error}</p>}</div>
    </aside></div>
    {mintOpen && mintDraft && <MintDetailsDialog collections={collections} title={title} setTitle={setTitle} description={description} setDescription={setDescription} traits={traits} setTraits={setTraits} collectionId={collectionId} setCollectionId={setCollectionId} busy={busy} error={error} onClose={() => setMintOpen(false)} onConfirm={() => { if (mintDraft) void onMint({ ...mintDraft, title: title.trim(), description, traits, collectionId }) }} />}
  </main>
}
