// @ts-nocheck
import * as U from "react";
import * as W from "react/jsx-runtime";
import {
  zipSync as or,
  strToU8 as Qn,
  strFromU8 as $n,
  unzipSync as sr,
} from "fflate";
import { GifReader, GifWriter } from "omggif";
import {
  loadStudioDraft as q,
  saveStudioDraft as Lt,
  deleteStudioDraft,
} from "./lib/studio-drafts";
import { archiveCreatorCollection, fetchCreatorArchive } from "./lib/backend";
import { Button as K, Icon as G } from "./ui";
const Nt = { GifReader, GifWriter };
export type TransferAsset = {
  name: string;
  description: string;
  attributes: { trait_type: string; value: string }[];
  file: Blob;
  animation?: Blob;
  rarityScore?: number;
};
const TRAIT_PRESETS = [
  { name: `Background color`, examples: `Midnight blue, sunset orange, emerald green, lavender, cream`, values: [`Midnight blue`, `Sunset orange`, `Emerald green`, `Lavender`, `Cream`] },
  { name: `Texture`, examples: `Matte, glossy, metallic, holographic, speckled`, values: [`Matte`, `Glossy`, `Metallic`, `Holographic`, `Speckled`] },
  { name: `Body`, examples: `Black, cream, white, warm tan, deep brown`, values: [`Black`, `Cream`, `White`, `Warm tan`, `Deep brown`] },
  { name: `Clothes`, examples: `Dress, sportswear, robe, streetwear, punk jacket`, values: [`Dress`, `Sportswear`, `Robe`, `Streetwear`, `Punk jacket`] },
  { name: `Mouth`, examples: `Happy smile, sad frown, angry, neutral, surprised`, values: [`Happy smile`, `Sad frown`, `Angry`, `Neutral`, `Surprised`] },
  { name: `Hair`, examples: `Punk spikes, long braids, low cut, curly, silver bob`, values: [`Punk spikes`, `Long braids`, `Low cut`, `Curly`, `Silver bob`] },
  { name: `Eyes`, examples: `Calm, angry, starry, closed, glowing`, values: [`Calm`, `Angry`, `Starry`, `Closed`, `Glowing`] },
];
function defaultGenerationTraits() {
  return TRAIT_PRESETS.map(category => ({ id: crypto.randomUUID(), name: category.name, options: [] }));
}
function collectionSymbol(name) {
  return String(name ?? ``).toUpperCase().replace(/[^A-Z0-9]/g, ``).slice(0, 20);
}
function cleanDefaultTraitExamples(categories) {
  return categories.map(category => {
    const preset = TRAIT_PRESETS.find(item => item.name === category.name);
    const options = category.options ?? [];
    const areOnlyExamples = preset && options.length === preset.values.length && preset.values.every((value, index) => options[index]?.value?.toLowerCase() === value.toLowerCase());
    return areOnlyExamples ? { ...category, options: [] } : category;
  });
}
var cr = {
    mode: `characters`,
    prompt: ``,
    collectionName: ``,
    symbol: ``,
    description: ``,
    totalSupply: 5,
    collectionSlug: ``,
    launchComplete: !1,
    mintStartAt: ``,
    mintDurationHours: 24,
    mintPerWalletLimit: 1,
    count: 5,
    pixelStyle: !1,
    resolution: 512,
    fps: 8,
    nameTemplate: `{collection} #{edition}`,
    descriptionTemplate: `{description}`,
    externalUrl: ``,
    generationTraits: defaultGenerationTraits(),
    rarityMix: { high: 10, medium: 30, common: 60 },
    layers: [],
    rules: [],
    tagGroups: [],
    templates: [],
    candidates: [],
  },
  lr = 1e4;
function ur(e, t) {
  return new File([e], t, { type: e.type || `image/png` });
}
function dr(e) {
  return (
    e
      .trim()
      .replace(/[^a-z0-9]+/gi, `-`)
      .replace(/^-|-$/g, ``)
      .toLowerCase() || `artwork`
  );
}
function fr(e) {
  return (
    e.name
      .replace(/\.[^.]+$/, ``)
      .replace(/[_-]+/g, ` `)
      .trim() || `Trait`
  );
}
function pr(e, t) {
  return Object.entries(t).reduce((e, [t, n]) => e.split(`{${t}}`).join(n), e);
}
function mr(e) {
  let t = e.reduce((e, t) => e + Math.max(0, t.weight), 0),
    n = Math.random() * (t || e.length);
  for (let r of e) if (((n -= t ? Math.max(0, r.weight) : 1), n < 0)) return r;
  return e[e.length - 1];
}
function hr(e) {
  return new Promise((t, n) => {
    let r = URL.createObjectURL(e),
      i = new Image();
    ((i.onload = () => {
      (URL.revokeObjectURL(r), t(i));
    }),
      (i.onerror = () => {
        (URL.revokeObjectURL(r), n(Error(`Could not read ${e.name}`)));
      }),
      (i.src = r));
  });
}
async function gr(e, t, n, r, i = [], a = 8) {
  let o = document.createElement(`canvas`);
  o.width = o.height = r;
  let s = o.getContext(`2d`, { willReadFrequently: !0 });
  if (!s) throw Error(`Could not prepare the artwork canvas`);
  s.imageSmoothingEnabled = !n;
  let c = t.map((t, n) => ({ trait: t, layer: e[n] })).filter(e => !!e.trait),
    l = await Promise.all(
      c.map(async ({ trait: e }) =>
        e.file.type === `image/gif` ? _r(e.file) : null
      )
    ),
    u = Math.min(
      20,
      Math.max(1, ...l.filter(e => !!e).map(e => e.frames.length))
    ),
    d = [],
    f = null;
  for (let e = 0; e < u; e += 1) {
    s.clearRect(0, 0, r, r);
    for (let t = 0; t < c.length; t += 1) {
      let { trait: n } = c[t],
        i = l[t];
      if (i) {
        let t = i.frames[e % i.frames.length],
          n = document.createElement(`canvas`);
        ((n.width = i.width),
          (n.height = i.height),
          n
            .getContext(`2d`)
            ?.putImageData(new ImageData(t, i.width, i.height), 0, 0),
          s.drawImage(n, 0, 0, r, r));
      } else {
        let e = await hr(n.file);
        s.drawImage(e, 0, 0, r, r);
      }
    }
    (e === 0 && (f = await new Promise(e => o.toBlob(e, `image/png`))),
      u > 1 && d.push(s.getImageData(0, 0, r, r).data.slice()));
  }
  if (!f) throw Error(`Could not assemble this artwork`);
  let p = u > 1 ? vr(d, r, a) : null,
    m = t.flatMap((t, n) =>
      t && e[n].includeMetadata && t.includeMetadata !== !1
        ? [{ trait_type: e[n].name, value: t.name }]
        : []
    ),
    h = new Set(t.flatMap(e => (e ? [e.id] : [])));
  for (let e of i)
    if (e.includeMetadata)
      for (let t of e.tags)
        t.traitIds.length &&
          t.traitIds.every(e => h.has(e)) &&
          m.push({ trait_type: e.name, value: t.name });
  return { blob: f, animation: p, attributes: m };
}
async function _r(e) {
  let t = new Nt.GifReader(new Uint8Array(await e.arrayBuffer())),
    n = t.width,
    r = t.height,
    i = Math.min(20, t.numFrames()),
    a = new Uint8Array(n * r * 4),
    o = [],
    s = null;
  for (let e = 0; e < i; e += 1) {
    let r = t.frameInfo(e);
    if (
      (r.disposal === 3 && (s = a.slice()),
      t.decodeAndBlitFrameRGBA(e, a),
      o.push(new Uint8ClampedArray(a)),
      r.disposal === 2)
    )
      for (let e = r.y; e < r.y + r.height; e += 1)
        a.fill(0, (e * n + r.x) * 4, (e * n + r.x + r.width) * 4);
    else r.disposal === 3 && s && a.set(s);
  }
  return { width: n, height: r, frames: o };
}
function vr(e, t, n) {
  let r = Array.from({ length: 256 }, (e, t) => {
      let n = Math.max(0, t - 1);
      return (
        (((((n >> 5) & 7) * 255) / 7) << 16) |
        (((((n >> 2) & 7) * 255) / 7) << 8) |
        (((n & 3) * 255) / 3)
      );
    }),
    i = new Uint8Array(Math.max(65536, t * t * e.length * 2 + 65536)),
    a = new Nt.GifWriter(i, t, t, { palette: r, loop: 0 });
  for (let r of e) {
    let e = new Uint8Array(t * t);
    for (let t = 0; t < e.length; t += 1) {
      let n = r[t * 4 + 3],
        i =
          ((r[t * 4] >> 5) << 5) |
          ((r[t * 4 + 1] >> 5) << 2) |
          (r[t * 4 + 2] >> 6);
      e[t] = n < 128 ? 0 : Math.min(255, i + 1);
    }
    a.addFrame(0, 0, t, t, e, {
      delay: Math.max(2, Math.round(100 / n)),
      disposal: 2,
      transparent: 0,
    });
  }
  return new Blob([i.slice(0, a.end())], { type: `image/gif` });
}
function yr({
  candidate: e,
  onToggle: t,
  onRename: n,
  onRemove: r,
  onAnalyze: i,
  onVerify: verify,
  onAttributesChange: a,
  analyzing: o,
  rarityScore: rarity,
}) {
  let [s, c] = (0, U.useState)(``);
  (0, U.useEffect)(() => {
    let t = URL.createObjectURL(e.file);
    return (c(t), () => URL.revokeObjectURL(t));
  }, [e.file]);
  let l = (t, n, r) =>
    a(e.attributes.map((e, i) => (i === t ? { ...e, [n]: r } : e)));
  return (0, W.jsxs)(`article`, {
    className: `ai-collection-candidate ${e.selected ? `is-selected` : ``}`,
    children: [
      (0, W.jsxs)(`button`, {
        className: `ai-collection-candidate__image`,
        onClick: t,
        "aria-label": `${e.selected ? `Remove` : `Select`} ${e.name}`,
        children: [
          (0, W.jsx)(`img`, { src: s, alt: e.name }),
          (0, W.jsx)(`span`, { children: e.selected ? `Selected` : `Review` }),
        ],
      }),
      (0, W.jsxs)(`div`, {
        className: `ai-collection-candidate__body`,
        children: [
          (0, W.jsx)(`input`, {
            "aria-label": `NFT name`,
            value: e.name,
            maxLength: 160,
            onChange: e => n(e.target.value),
          }),
          (0, W.jsxs)(`small`, {
            children: [
              e.animation ? `Animated GIF` : ``,
              e.attributes.length
                ? `${e.animation ? ` · ` : ``}${e.attributes.map(e => `${e.trait_type}: ${e.value}`).join(` · `)}`
                : e.animation
                  ? ``
                  : `AI artwork variation`,
            ],
          }),
          e.attributes.length > 0 && (0, W.jsx)(`small`, { className: `ai-collection-rarity`, children: `Rarity score ${rarity}` }),
          (0, W.jsxs)(`details`, {
            className: `ai-collection-attributes`,
            children: [
              (0, W.jsx)(`summary`, {
                children: e.attributes.length
                  ? `Edit ${e.attributes.length} assigned traits`
                  : `Artwork traits`,
              }),
              e.attributes.map((t, n) =>
                (0, W.jsxs)(
                  `div`,
                  {
                    className: `ai-collection-attribute`,
                    children: [
                      (0, W.jsx)(`input`, {
                        "aria-label": `Trait category`,
                        value: t.trait_type,
                        maxLength: 48,
                        onChange: e => l(n, `trait_type`, e.target.value),
                      }),
                      (0, W.jsx)(`input`, {
                        "aria-label": `Trait value`,
                        value: t.value,
                        maxLength: 80,
                        onChange: e => l(n, `value`, e.target.value),
                      }),
                      (0, W.jsx)(`button`, {
                        type: `button`,
                        onClick: () =>
                          a(e.attributes.filter((e, t) => t !== n)),
                        "aria-label": `Remove trait`,
                        children: `×`,
                      }),
                    ],
                  },
                  `${e.id}-${n}`
                )
              ),
              (0, W.jsx)(`button`, {
                type: `button`,
                onClick: () =>
                  a([...e.attributes, { trait_type: ``, value: `` }]),
                children: `Add trait`,
              }),
            ],
          }),
          (0, W.jsx)(`button`, {
            className: `ai-collection-analyze`,
            type: `button`,
            onClick: i,
            disabled: o,
            children: o
              ? `Reading artwork traits…`
              : e.attributes.length
                ? `Regenerate traits`
                : `Generate traits from artwork`,
          }),
          e.attributes.length > 0 && (0, W.jsxs)(W.Fragment, {
            children: [
              (0, W.jsx)(`button`, {
                className: `ai-collection-verify`,
                type: `button`,
                onClick: verify,
                disabled: o,
                children: o ? `Checking assigned traits…` : e.traitAudit ? `Check traits again` : `Check image against assigned traits`,
              }),
              e.traitAudit && (0, W.jsxs)(`div`, {
                className: `ai-collection-trait-audit`,
                children: [
                  (0, W.jsx)(`strong`, { children: e.traitAudit.summary || `AI trait check` }),
                  e.traitAudit.checks.map((check, index) => (0, W.jsxs)(`small`, {
                    className: `is-${check.status}`,
                    children: [`${check.status === `visible` ? `✓` : check.status === `missing` ? `!` : `?`} ${check.trait_type}: ${check.expected}`, check.observed ? ` · Seen: ${check.observed}` : ``],
                  }, `${e.id}-audit-${index}`)),
                  (0, W.jsx)(`small`, { children: `AI review is a guide. Confirm the artwork yourself before publishing.` }),
                ],
              }),
            ],
          }),
          (0, W.jsxs)(`button`, {
            className: `ai-collection-remove`,
            onClick: r,
            "aria-label": `Remove ${e.name}`,
            children: [(0, W.jsx)(G, { name: `close`, size: 14 }), ` Remove`],
          }),
        ],
      }),
    ],
  });
}
function br({ file: e, name: t }) {
  let [n, r] = (0, U.useState)(``);
  return (
    (0, U.useEffect)(() => {
      let t = URL.createObjectURL(e);
      return (r(t), () => URL.revokeObjectURL(t));
    }, [e]),
    (0, W.jsx)(`img`, { src: n, alt: `${t} trait` })
  );
}
function generationAssignments(categories, count) {
  if (!categories.length) return Array.from({ length: count }, () => []);
  if (categories.some(category => !category.options.some(option => option.value.trim() && option.weight > 0))) throw Error(`Every trait category needs at least one named value with a weight above zero.`);
  const options = categories.map(category => category.options.filter(option => option.value.trim() && option.weight > 0));
  const capacity = options.reduce((total, values) => total * values.length, 1);
  if (capacity < count) throw Error(`These traits create only ${capacity} unique combinations; add values or reduce the batch of ${count}.`);
  const used = new Set();
  const weightedOrder = values => {
    const remaining = [...values], ordered = [];
    while (remaining.length) {
      const selected = mr(remaining);
      ordered.push(selected);
      remaining.splice(remaining.indexOf(selected), 1);
    }
    return ordered;
  };
  return Array.from({ length: count }, () => {
    let selected = [], key = ``;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      selected = options.map(values => mr(values));
      key = selected.map(option => option.id).join(`|`);
      if (!used.has(key)) break;
    }
    if (used.has(key)) {
      const findUnused = (index, partial) => {
        if (index === options.length) return used.has(partial.map(option => option.id).join(`|`)) ? null : [...partial];
        for (const option of weightedOrder(options[index])) {
          partial.push(option);
          const found = findUnused(index + 1, partial);
          if (found) return found;
          partial.pop();
        }
        return null;
      };
      selected = findUnused(0, []);
      if (!selected) throw Error(`Could not assign a unique trait combination. Add more values or reduce the batch.`);
      key = selected.map(option => option.id).join(`|`);
    }
    used.add(key);
    return categories.map((category, index) => ({ category, option: selected[index] }));
  });
}
function generationRarity(candidate, candidates) {
  if (!candidate.attributes.length || !candidates.length) return ``;
  const score = candidate.attributes.reduce((total, attribute) => {
    const frequency = candidates.filter(item => item.attributes.some(value => value.trait_type === attribute.trait_type && value.value === attribute.value)).length;
    return total + candidates.length / Math.max(1, frequency);
  }, 0);
  return score.toFixed(2);
}
export type RarityTier = `high` | `medium` | `common`;
export type RarityMix = Record<RarityTier, number>;
export function getRarityTierCounts(total: number, mix: RarityMix): RarityMix {
  const tiers = [`high`, `medium`, `common`].map(key => ({ key, raw: Math.max(0, Number(mix?.[key]) || 0) * total / 100 }));
  const counts = tiers.map(tier => Math.floor(tier.raw));
  let left = Math.max(0, total - counts.reduce((sum, value) => sum + value, 0));
  const order = tiers.map((tier, index) => ({ index, fraction: tier.raw - counts[index] })).sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < left; i += 1) counts[order[i % order.length].index] += 1;
  return { high: counts[0], medium: counts[1], common: counts[2] };
}
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const shuffled = [...items];
  let state = seed >>> 0 || 0x9e3779b9;
  const random = () => { state = (state + 0x6d2b79f5) | 0; let value = Math.imul(state ^ (state >>> 15), 1 | state); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
  for (let index = shuffled.length - 1; index > 0; index -= 1) { const other = Math.floor(random() * (index + 1)); [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]; }
  return shuffled;
}
export function getRarityTierSchedule(total: number, mix: RarityMix, seed = 1): RarityTier[] {
  const counts = getRarityTierCounts(total, mix), keys = [`high`, `medium`, `common`], assigned = { high: 0, medium: 0, common: 0 }, schedule = [];
  for (let index = 0; index < total; index += 1) {
    let selected = keys[0], deficit = -Infinity;
    for (const key of keys) {
      const nextDeficit = ((index + 1) * counts[key] / Math.max(1, total)) - assigned[key];
      if (nextDeficit > deficit) { selected = key; deficit = nextDeficit; }
    }
    assigned[selected] += 1;
    schedule.push(selected);
  }
  return seededShuffle(schedule, seed);
}
function SupplyRarityEditor({ supply, mix, onChange }) {
  const total = Number(mix.high) + Number(mix.medium) + Number(mix.common);
  const counts = getRarityTierCounts(supply, mix);
  const setPercent = (key, raw) => onChange({ ...mix, [key]: raw === `` ? `` : raw });
  const commitPercent = key => onChange({ ...mix, [key]: Math.max(0, Math.min(100, Number(mix[key]) || 0)) });
  return <section className="ai-collection-supply-rarity"><div><span className="eyebrow">SUPPLY RARITY MIX</span><p>Generate up to 8 master artworks, then reuse them across your full supply. The rarest masters fill the high tier; edition metadata is expanded to match these percentages.</p></div><div className="ai-collection-rarity-fields">{[[`high`, `High rarity`], [`medium`, `Medium rarity`], [`common`, `Common rarity`]].map(([key, label]) => <label key={key}>{label}<span><input type="number" min="0" max="100" value={mix[key] ?? ``} onChange={event => setPercent(key, event.target.value)} onBlur={() => commitPercent(key)} />%</span><small>{counts[key].toLocaleString()} editions</small></label>)}</div><small className={total === 100 ? `ai-collection-rarity-total` : `ai-collection-rarity-total is-invalid`}>{total}% total · {total === 100 ? `${counts.high.toLocaleString()} high · ${counts.medium.toLocaleString()} medium · ${counts.common.toLocaleString()} common out of ${Number(supply).toLocaleString()}` : `Set percentages to add up to 100%.`}</small></section>;
}
function PromptTraitsEditor({ categories, onChange }) {
  const [drafts, setDrafts] = U.useState(() => Object.fromEntries(categories.map(category => [category.id, category.options.map(option => option.value).join(`, `)])));
  const [name, setName] = U.useState(``), [values, setValues] = U.useState(``);
  const addCategory = () => {
    const category = name.trim(), traits = [...new Set(values.split(/[,\n]+/).map(value => value.trim()).filter(Boolean))];
    if (!category || traits.length < 2 || categories.some(item => item.name.toLowerCase() === category.toLowerCase())) return;
    onChange([...categories, { id: crypto.randomUUID(), name: category, options: traits.map(value => ({ id: crypto.randomUUID(), value, weight: 100 })) }]);
    setName(``); setValues(``);
  };
  const update = next => onChange(categories.map(item => item.id === next.id ? next : item));
  const editValues = (category, raw) => {
    const nextValues = [...new Set(raw.split(`,`).map(value => value.trim()).filter(Boolean))];
    update({ ...category, options: nextValues.map(value => category.options.find(item => item.value.toLowerCase() === value.toLowerCase()) ?? { id: crypto.randomUUID(), value, weight: 100 }) });
  };
  return <div className="ai-collection-prompt-traits">
    <div><span className="eyebrow">TRAITS</span><p>Enter options separated by commas. The studio picks a combination for each artwork and adds it to the image prompt and NFT metadata.</p></div>
    <div className="ai-collection-trait-list">{categories.map(category => <label className="ai-collection-trait-row" key={category.id}>
      <span>{category.name}</span>
      <input value={drafts[category.id] ?? category.options.map(option => option.value).join(`, `)} onChange={event => { const raw = event.target.value; setDrafts(current => ({ ...current, [category.id]: raw })); editValues(category, raw); }} placeholder={TRAIT_PRESETS.find(item => item.name === category.name)?.examples ?? `e.g. Silver, Gold, Crystal`} aria-label={`${category.name} trait values`} />
    </label>)}</div>
  </div>;
}
function xr({
  onGenerate: e,
  onAnalyze: t,
  onVerifyTraits: verifyTraits,
  onPlanTraits: planTraits,
  onCreateCollection: n,
  onSaveArtwork: r,
  onOpenCollectionDashboard: openDashboard,
  walletAddress,
  onHome: i,
}) {
  let [a, o] = (0, U.useState)(cr),
    [s, c] = (0, U.useState)(`manage`),
    [l, u] = (0, U.useState)(``),
    [d, f] = (0, U.useState)(``),
    [p, m] = (0, U.useState)(0),
    [h, g] = (0, U.useState)(!0),
    [_, v] = (0, U.useState)(!1),
    [y, b] = (0, U.useState)(``),
    [x, S] = (0, U.useState)(``),
    [C, w] = (0, U.useState)(``),
    [T, E] = (0, U.useState)({}),
    [D, O] = (0, U.useState)(``),
    [k, ee] = (0, U.useState)(``),
    [A, j] = (0, U.useState)(``),
    [M, N] = (0, U.useState)({}),
    [te, ne] = (0, U.useState)([]);
  const [archiveItems, setArchiveItems] = U.useState([]);
  const [archiveLoading, setArchiveLoading] = U.useState(false);
  (0, U.useEffect)(() => {
    let active = true;
    if (!walletAddress) {
      setArchiveItems([]);
      return () => { active = false; };
    }
    setArchiveLoading(true);
    fetchCreatorArchive(walletAddress)
      .then(items => { if (active) setArchiveItems(items); })
      .catch(() => { if (active) setArchiveItems([]); })
      .finally(() => { if (active) setArchiveLoading(false); });
    return () => { active = false; };
  }, [walletAddress]);
  (0, U.useEffect)(() => {
    let e = !0;
    return (
      q(`ai-collection`)
        .then(async t => {
          if (!e || !t) return;
          if (t.launchComplete && t.collectionSlug && walletAddress) {
            try {
              await archiveCreatorCollection(walletAddress, t.collectionSlug, t.candidates?.length ?? 0);
              const items = await fetchCreatorArchive(walletAddress);
              await deleteStudioDraft(`ai-collection`);
              if (!e) return;
              setArchiveItems(items);
              o(cr);
              c(`archive`);
              w(`${t.collectionName || `Your collection`} is saved in your archive. Start a new collection any time.`);
            } catch {
              o({ ...cr, ...t, mode: `characters`, collectionSlug: t.collectionSlug ?? ``, launchComplete: !0 });
            }
            return;
          }
          o({
              ...cr,
              ...t,
              mode: `characters`,
              count: Math.min(8, Math.max(1, Number(t.count) || 5)),
              // Clear symbols generated by the old name-to-ticker behavior in
              // an uncreated draft, so creators can enter their own value.
              symbol: t.collectionSlug || t.symbol !== collectionSymbol(t.collectionName) ? t.symbol ?? `` : ``,
              totalSupply: t.totalSupply ?? t.count ?? 5,
              collectionSlug: t.collectionSlug ?? ``,
              launchComplete: t.launchComplete ?? !1,
              mintStartAt: t.mintStartAt ?? ``,
              mintDurationHours: t.mintDurationHours ?? 24,
              mintPerWalletLimit: t.mintPerWalletLimit ?? 1,
              fps: t.fps ?? 8,
              generationTraits: t.generationTraits?.length ? cleanDefaultTraitExamples(t.generationTraits) : defaultGenerationTraits(),
              rarityMix: t.rarityMix ?? { high: 10, medium: 30, common: 60 },
              layers: (t.layers ?? []).map(e => ({
                ...e,
                appearance: e.appearance ?? 100,
                includeMetadata: e.includeMetadata ?? !0,
                traits: (e.traits ?? []).map(e => ({
                  ...e,
                  weight: e.weight ?? 100,
                  includeMetadata: e.includeMetadata ?? !0,
                  exactCount: e.exactCount ?? null,
                })),
              })),
              rules: t.rules ?? [],
              tagGroups: t.tagGroups ?? [],
              templates: t.templates ?? [],
            });
        })
        .catch(() => {})
        .finally(() => {
          e && g(!1);
        }),
      () => {
        e = !1;
      }
    );
  }, [walletAddress]);
  let P = (0, U.useMemo)(
      () => a.candidates.filter(e => e.selected),
      [a.candidates]
    ),
    F = (0, U.useMemo)(
      () => a.layers.reduce((e, t) => e * Math.max(1, t.traits.length), 1),
      [a.layers]
    ),
    I = (0, U.useMemo)(
      () =>
        a.candidates.filter(
          (e, t) =>
            (!l ||
              `${e.name} ${t + 1} ${JSON.stringify(e.attributes)}`
                .toLowerCase()
                .includes(l.toLowerCase())) &&
            (!d || e.attributes.some(e => `${e.trait_type}:${e.value}` === d))
        ),
      [a.candidates, l, d]
    ),
    re = I.slice(p * 48, p * 48 + 48),
    L = async (e = a) => {
      (await Lt(`ai-collection`, e),
        o(e),
        w(`Draft saved on this device.`),
        window.setTimeout(() => w(``), 2500));
    },
    ie = () => {
      let e = D.trim();
      e
        ? a.layers.some(t => t.name.toLowerCase() === e.toLowerCase())
          ? S(`Each trait category needs a unique name.`)
          : (o(t => ({
              ...t,
              layers: [
                ...t.layers,
                {
                  id: crypto.randomUUID(),
                  name: e,
                  traits: [],
                  appearance: 100,
                  includeMetadata: !0,
                },
              ],
            })),
            O(``),
            S(``))
        : S(`Name the trait category first.`);
    },
    ae = () => {
      let e = k.trim();
      e
        ? (o(t => ({
            ...t,
            templates: [
              ...t.templates,
              {
                id: crypto.randomUUID(),
                name: e,
                weight: 100,
                layerIds: t.layers.map(e => e.id),
              },
            ],
          })),
          ee(``),
          S(``))
        : S(`Name this template first.`);
    },
    R = () => {
      let e = A.trim();
      e
        ? (o(t => ({
            ...t,
            tagGroups: [
              ...t.tagGroups,
              {
                id: crypto.randomUUID(),
                name: e,
                includeMetadata: !0,
                tags: [],
              },
            ],
          })),
          j(``),
          S(``))
        : S(`Name the tag group first.`);
    },
    oe = e => {
      let t = M[e];
      !t?.name.trim() || !t.traitIds.length
        ? S(`Give the tag a name and choose at least one matching trait.`)
        : (o(n => ({
            ...n,
            tagGroups: n.tagGroups.map(n =>
              n.id === e
                ? {
                    ...n,
                    tags: [
                      ...n.tags,
                      {
                        id: crypto.randomUUID(),
                        name: t.name.trim(),
                        traitIds: t.traitIds,
                      },
                    ],
                  }
                : n
            ),
          })),
          N(t => ({ ...t, [e]: { name: ``, traitIds: [] } })),
          S(``));
    },
    se = (e, t) => {
      let n = t.filter(e => e.type.startsWith(`image/`));
      (n.length !== t.length && S(`Only image files can be used as traits.`),
        o(t => ({
          ...t,
          layers: t.layers.map(t =>
            t.id === e
              ? {
                  ...t,
                  traits: [
                    ...t.traits,
                    ...n.map(e => ({
                      id: crypto.randomUUID(),
                      name: fr(e),
                      weight: 100,
                      exactCount: null,
                      includeMetadata: !0,
                      file: e,
                    })),
                  ],
                }
              : t
          ),
        })));
    },
    ce = async e => {
      if (e?.length) {
        (S(``), b(`Importing artwork assets…`));
        try {
          let t = [];
          for (let n of Array.from(e))
            if (n.name.toLowerCase().endsWith(`.zip`)) {
              let e = sr(new Uint8Array(await n.arrayBuffer()));
              for (let [n, r] of Object.entries(e)) {
                if (n.endsWith(`/`) || !/\.(png|jpe?g|webp|gif|svg)$/i.test(n))
                  continue;
                let e = n.toLowerCase().endsWith(`.svg`)
                  ? `image/svg+xml`
                  : n.toLowerCase().endsWith(`.jpg`) ||
                      n.toLowerCase().endsWith(`.jpeg`)
                    ? `image/jpeg`
                    : n.toLowerCase().endsWith(`.webp`)
                      ? `image/webp`
                      : n.toLowerCase().endsWith(`.gif`)
                        ? `image/gif`
                        : `image/png`;
                t.push({
                  path: n,
                  file: new File(
                    [r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength)],
                    n.split(`/`).pop() || `asset.png`,
                    { type: e }
                  ),
                });
              }
            } else
              n.type.startsWith(`image/`) &&
                t.push({ path: n.webkitRelativePath || n.name, file: n });
          if (!t.length)
            throw Error(
              `The selected folder or ZIP contains no supported artwork images.`
            );
          let n = new Map();
          for (let e of t) {
            let t = e.path.split(`/`).filter(Boolean),
              r = t.length > 1 ? t[t.length - 2] : `Imported traits`;
            n.set(r, [...(n.get(r) ?? []), e.file]);
          }
          (o(e => {
            let t = e.layers.slice();
            for (let [e, r] of n) {
              let n = t.find(t => t.name.toLowerCase() === e.toLowerCase());
              (n ||
                ((n = {
                  id: crypto.randomUUID(),
                  name: e,
                  traits: [],
                  appearance: 100,
                  includeMetadata: !0,
                }),
                t.push(n)),
                (n.traits = [
                  ...n.traits,
                  ...r.map(e => ({
                    id: crypto.randomUUID(),
                    name: fr(e),
                    weight: 100,
                    exactCount: null,
                    includeMetadata: !0,
                    file: e,
                  })),
                ]));
            }
            return { ...e, layers: t };
          }),
            b(
              `Imported ${t.length} image assets across ${n.size} trait categories.`
            ));
        } catch (e) {
          (S(
            e instanceof Error
              ? e.message
              : `Could not import the selected assets.`
          ),
            b(``));
        }
      }
    },
    le = async e => {
      if (e?.length) {
        (S(``), b(`Importing finished artwork and metadata…`));
        try {
          let t = [],
            n = new Map(),
            r = [];
          for (let i of Array.from(e))
            if (i.name.toLowerCase().endsWith(`.zip`)) {
              let e = sr(new Uint8Array(await i.arrayBuffer()));
              for (let [i, a] of Object.entries(e))
                if (!i.endsWith(`/`)) {
                  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(i)) {
                    let e = i.toLowerCase().endsWith(`.svg`)
                      ? `image/svg+xml`
                      : i.toLowerCase().endsWith(`.jpg`) ||
                          i.toLowerCase().endsWith(`.jpeg`)
                        ? `image/jpeg`
                        : i.toLowerCase().endsWith(`.webp`)
                          ? `image/webp`
                          : i.toLowerCase().endsWith(`.gif`)
                            ? `image/gif`
                            : `image/png`;
                    t.push({
                      path: i,
                      file: new File(
                        [
                          a.buffer.slice(
                            a.byteOffset,
                            a.byteOffset + a.byteLength
                          ),
                        ],
                        i.split(`/`).pop() || `artwork.png`,
                        { type: e }
                      ),
                    });
                  } else if (/\.json$/i.test(i))
                    try {
                      let e = JSON.parse($n(a)),
                        t = i
                          .split(`/`)
                          .pop()
                          .replace(/\.json$/i, ``)
                          .toLowerCase();
                      if (Array.isArray(e))
                        r.push(...e.filter(e => !!(e && typeof e == `object`)));
                      else if (e && typeof e == `object`) {
                        let i = e;
                        Array.isArray(i.artworks)
                          ? r.push(
                              ...i.artworks.filter(
                                e => !!(e && typeof e == `object`)
                              )
                            )
                          : n.set(t, i);
                      }
                    } catch {}
                }
            } else if (i.type.startsWith(`image/`))
              t.push({ path: i.webkitRelativePath || i.name, file: i });
            else if (i.name.toLowerCase().endsWith(`.json`)) {
              let e = JSON.parse(await i.text());
              Array.isArray(e)
                ? r.push(...e.filter(e => !!(e && typeof e == `object`)))
                : e &&
                  typeof e == `object` &&
                  n.set(i.name.replace(/\.json$/i, ``).toLowerCase(), e);
            }
          if (!t.length) throw Error(`No supported artwork images were found.`);
          (r
            .map(e => [
              String(e.image ?? e.edition ?? e.name ?? ``)
                .replace(/^.*\//, ``)
                .replace(/\.[^.]+$/, ``)
                .toLowerCase(),
              e,
            ])
            .forEach(([e, t]) => {
              e && n.set(e, t);
            }),
            t.sort((e, t) =>
              e.path.localeCompare(t.path, void 0, {
                numeric: !0,
                sensitivity: `base`,
              })
            ));
          let i = [];
          for (let [e, o] of t.entries()) {
            let t = o.path
                .split(`/`)
                .pop()
                .replace(/\.[^.]+$/, ``)
                .toLowerCase(),
              s = String(Number(t)).toLowerCase(),
              c =
                n.get(t) ??
                n.get(s) ??
                r.find(e => String(e.edition ?? e.token_id ?? ``) === s),
              l = (Array.isArray(c?.attributes) ? c.attributes : []).flatMap(
                e =>
                  e && typeof e == `object` && `trait_type` in e && `value` in e
                    ? [
                        {
                          trait_type: String(e.trait_type),
                          value: String(e.value),
                        },
                      ]
                    : []
              ),
              u = e + 1,
              d = new File([o.file], o.file.name, { type: o.file.type });
            i.push({
              id: crypto.randomUUID(),
              name: String(
                c?.name ?? `${a.collectionName.trim() || `Collection`} #${u}`
              ),
              description:
                typeof c?.description == `string` ? c.description : void 0,
              file: d,
              animation: d.type === `image/gif` ? d : void 0,
              attributes: l,
              selected: !0,
            });
          }
          (o(e => ({ ...e, mode: `custom`, count: i.length, candidates: i })),
            b(
              `Imported ${i.length} finished artwork files${n.size ? ` and matched ${n.size} metadata records` : ``}.`
            ));
        } catch (e) {
          (S(
            e instanceof Error
              ? e.message
              : `Could not import the artwork and metadata.`
          ),
            b(``));
        }
      }
    },
    z = () => {
      let e = a.layers.flatMap(e => e.traits);
      e.length < 2
        ? S(`Add at least two traits before creating compatibility rules.`)
        : (o(t => ({
            ...t,
            rules: [
              ...t.rules,
              {
                id: crypto.randomUUID(),
                kind: `exclude`,
                source: e[0].id,
                targets: [e[1].id],
              },
            ],
          })),
          S(``));
    },
    B = async t => {
      let n = (T[t.id] || ``).trim();
      if (n.length < 8)
        S(`Describe a ${t.name.toLowerCase()} trait in at least 8 characters.`);
      else {
        (v(!0), S(``), b(`Generating ${t.name.toLowerCase()} trait…`));
        try {
          let r = await e(
              `${n}. Create one isolated NFT trait asset, centered, square canvas, clean edges, no text, no border.${a.pixelStyle ? ` Crisp pixel art with a consistent pixel grid; no antialiasing.` : ``}`,
              !0
            ),
            i = r.type.includes(`jpeg`)
              ? `jpg`
              : r.type.includes(`webp`)
                ? `webp`
                : `png`;
          (se(t.id, [
            new File([r], `${dr(n.slice(0, 36))}.${i}`, { type: r.type }),
          ]),
            b(
              `Trait generated. Check its alignment and transparency before assembling.`
            ));
        } catch (e) {
          S(e instanceof Error ? e.message : `Trait generation failed.`);
        } finally {
          v(!1);
        }
      }
    },
    ue = async () => {
      let n = a.prompt.trim();
      if (n.length < 8) {
        S(`Describe the collection artwork in at least 8 characters.`);
        return;
      }
      if (!a.collectionName.trim()) {
        S(`Add a collection name before generating its artwork.`);
        return;
      }
      let count = Math.min(8, Math.max(1, a.count)), assignments, categories = (a.generationTraits ?? []).map(category => ({ ...category, options: (category.options ?? []).filter(option => option.value.trim() && option.weight > 0) })), failures = [];
      (v(!0), S(``), b(`Preparing the collection trait plan…`));
      let r = [];
      try {
        const emptyCategories = categories.filter(category => !category.options.length);
        if (!categories.length || emptyCategories.length) {
          const categoryPrompt = emptyCategories.length
            ? `${n}\nRequired trait categories: ${JSON.stringify(emptyCategories.map(category => category.name))}. Return only these categories, keep each category name exactly as written, and create visible trait values that fit the collection.`
            : n;
          const plannedCategories = await planTraits(categoryPrompt, count);
          if (!Array.isArray(plannedCategories) || plannedCategories.length < 1) throw Error(`The AI did not return a usable collection trait plan. Try again.`);
          if (!categories.length) categories = plannedCategories;
          else {
            const plannedByName = new Map(plannedCategories.map(category => [category.name.trim().toLowerCase(), category]));
            const remaining = [...plannedCategories];
            categories = categories.map(category => {
              if (category.options.length) return category;
              const planned = plannedByName.get(category.name.trim().toLowerCase()) ?? remaining[0];
              if (!planned) throw Error(`The AI could not fill the ${category.name} trait category. Try again.`);
              remaining.splice(remaining.indexOf(planned), 1);
              return { ...category, options: planned.options };
            });
          }
          if (categories.length < 2 || categories.some(category => !category.options.length)) throw Error(`The AI did not return enough usable collection traits. Try again.`);
          o(current => ({ ...current, generationTraits: categories }));
          await Lt(`ai-collection`, { ...a, generationTraits: categories });
        }
        assignments = generationAssignments(categories, count);
        for (let i = 0; i < count; i += 1) {
          b(
            `Generating artwork ${i + 1} of ${count}…`
          );
          let s = a.pixelStyle
              ? ` Crisp pixel art, consistent pixel grid, sharp square pixels, no antialiasing.`
              : ` Polished digital illustration, square composition.`,
            attributes = assignments[i].map(({ category, option }) => ({ trait_type: category.name, value: option.value })),
            imageTraitLabels = { [`Background color`]: `background color palette`, Texture: `surface finish`, Body: `character color palette`, Clothes: `outfit`, Mouth: `facial expression`, Hair: `hairstyle`, Eyes: `eye expression` },
            traitPrompt = attributes.length ? `Depict these exact visual design choices in the artwork: ${assignments[i].map(({ category, option }) => `${imageTraitLabels[category.name] ?? category.name}: ${option.value}`).join(`; `)}. The character is fully dressed in the specified outfit. Treat every choice as a required part of the design.` : `Vary the background palette, surface finish, character palette, outfit, facial expression, hairstyle, and eye expression naturally across the collection where they fit the artwork.`;
          const requestPrompt = `${n}. Create a distinct collectible variation ${i + 1} of ${count} for one cohesive NFT collection. Keep the same central character and art direction. ${s} ${traitPrompt}`;
          let c;
          try {
            c = await e(requestPrompt);
          } catch (error) {
            const message = error instanceof Error ? error.message : `Image generation failed.`;
            const assignedTraits = attributes.length ? attributes.map(item => `${item.trait_type}: ${item.value}`).join(`; `) : `No manually assigned trait values`;
            failures.push(`Artwork ${i + 1}: ${message}\nArt description: ${n}\nAssigned traits: ${assignedTraits}`);
            b(`Artwork ${i + 1} was rejected. Continuing with the remaining images…`);
            continue;
          }
          let l = c.type.includes(`jpeg`)
              ? `jpg`
              : c.type.includes(`webp`)
                ? `webp`
                : `png`,
            u = {
              id: crypto.randomUUID(),
              name: pr(a.nameTemplate, {
                collection: a.collectionName.trim(),
                edition: String(i + 1),
              }),
              file: new File([c], `${dr(a.collectionName)}-${i + 1}.${l}`, {
                type: c.type,
              }),
              attributes,
              selected: !0,
            };
          if (attributes.length) {
            b(`Checking assigned traits on artwork ${i + 1} of ${count}…`);
            try {
              u.traitAudit = await verifyTraits(u.file, attributes);
            } catch {
              u.traitAudit = { summary: `AI trait check unavailable. Retry the check in Review.`, checks: [] };
            }
          }
          (r.push(u),
            o(e => ({ ...e, candidates: [...e.candidates, u] })),
            b(`Artwork ${i + 1} generated and trait-checked.`));
        }
        const traitIssues = r.filter(candidate => candidate.traitAudit && candidate.traitAudit.checks.some(check => check.status !== `visible`)).length;
        const unchecked = r.filter(candidate => !candidate.traitAudit?.checks.length).length;
        b(`${r.length} artwork variations generated. ${traitIssues ? `${traitIssues} need trait review.` : `Assigned traits checked.`}${unchecked ? ` ${unchecked} AI check${unchecked === 1 ? ` was` : `s were`} unavailable; retry in Review.` : ``}`);
        if (failures.length) S(`${r.length} image(s) generated; ${failures.length} rejected by the image provider. The failed item details below identify its prompt and assigned traits:\n\n${failures.join(`\n\n`)}`);
      } catch (e) {
        (S(e instanceof Error ? e.message : `Artwork generation failed.`),
          b(
            r.length
              ? `${r.length} variations were created before generation stopped.`
              : ``
          ));
      } finally {
        v(!1);
      }
    },
    de = async e => {
      (ne(t => [...t, e.id]), S(``));
      try {
        let n = await t(e.file);
        (o(t => ({
          ...t,
          candidates: t.candidates.map(t =>
          t.id === e.id ? { ...t, attributes: n, traitAudit: undefined } : t
          ),
        })),
          b(
            `Detected ${n.length} visible trait${n.length === 1 ? `` : `s`} for ${e.name}.`
          ));
      } catch (e) {
        S(e instanceof Error ? e.message : `Could not analyze this artwork.`);
      } finally {
        ne(t => t.filter(t => t !== e.id));
      }
    },
    checkAssignedTraits = async candidate => {
      (ne(current => [...current, candidate.id]), S(``));
      try {
        const audit = await verifyTraits(candidate.file, candidate.attributes);
        o(current => ({
          ...current,
          candidates: current.candidates.map(item => item.id === candidate.id ? { ...item, traitAudit: audit } : item),
        }));
        const mismatches = audit.checks.filter(item => item.status !== `visible`).length;
        b(mismatches ? `${mismatches} assigned trait${mismatches === 1 ? `` : `s`} need review on ${candidate.name}.` : `All assigned traits were visually confirmed on ${candidate.name}.`);
      } catch (error) {
        S(error instanceof Error ? error.message : `Could not verify the assigned traits.`);
      } finally {
        ne(current => current.filter(id => id !== candidate.id));
      }
    },
    fe = async () => {
      let e = a.layers.filter(e => e.traits.length);
      if (!a.collectionName.trim()) {
        S(`Add a collection name before assembling artwork.`);
        return;
      }
      if (!e.length || e.length !== a.layers.length) {
        S(`Add at least one image to every trait category.`);
        return;
      }
      if (!Number.isInteger(a.count) || a.count < 1 || a.count > lr) {
        S(`Choose between 1 and ${lr} artworks.`);
        return;
      }
      if (F < a.count) {
        S(
          `These layers allow only ${F} unique combinations. Add more traits or reduce the artwork count.`
        );
        return;
      }
      let t = e.find(
        e => e.traits.reduce((e, t) => e + (t.exactCount ?? 0), 0) > a.count
      );
      if (t)
        S(
          `Exact trait counts in ${t.name} add up to more than ${a.count} artworks.`
        );
      else if (
        a.rules.find(
          t =>
            !t.targets.length ||
            t.targets.includes(t.source) ||
            (t.kind === `pair` &&
              t.targets.some(
                n =>
                  e.find(e => e.traits.some(e => e.id === n))?.id ===
                  e.find(e => e.traits.some(e => e.id === t.source))?.id
              ))
        )
      )
        S(
          `A compatibility rule has no target or requires traits that cannot appear together in one category. Review the rules before generating.`
        );
      else {
        (v(!0), S(``), b(`Assembling artwork and checking for duplicates…`));
        try {
          let t = new Set(),
            n = [],
            r = new Map(),
            i = a.count * 20;
          for (let o = 0; n.length < a.count && o < i; o += 1) {
            let i = a.count - n.length,
              o = a.templates.length
                ? mr(
                    a.templates.filter(e => e.weight > 0).length
                      ? a.templates.filter(e => e.weight > 0)
                      : a.templates
                  )
                : null,
              s = new Set(o?.layerIds ?? e.map(e => e.id)),
              c = e.map(e => {
                if (!s.has(e.id)) return null;
                let t = e.traits.filter(
                    e =>
                      e.exactCount != null &&
                      (r.get(e.id) ?? 0) < Number(e.exactCount)
                  ),
                  n = t.reduce(
                    (e, t) => e + Number(t.exactCount) - (r.get(t.id) ?? 0),
                    0
                  ),
                  a = e.traits.filter(
                    e =>
                      e.exactCount == null ||
                      (r.get(e.id) ?? 0) < Number(e.exactCount)
                  ),
                  o = n >= i && t.length > 0;
                return !o && Math.random() * 100 >= e.appearance
                  ? null
                  : mr(o ? t : a);
              });
            if (
              c.some((t, n) => s.has(e[n].id) && !t && e[n].appearance >= 100)
            )
              continue;
            let l = new Set(c.filter(e => !!e).map(e => e.id));
            if (
              a.rules.some(e => {
                let t = l.has(e.source),
                  n = e.targets.filter(e => l.has(e)).length;
                return e.kind === `exclude`
                  ? t && n > 0
                  : e.kind === `only`
                    ? t && n === 0
                    : t
                      ? n !== e.targets.length
                      : n > 0;
              })
            )
              continue;
            let u = `${o?.id ?? `all`}:${c.map(e => e?.id ?? `-`).join(`:`)}`;
            if (t.has(u)) continue;
            t.add(u);
            let {
                blob: d,
                animation: f,
                attributes: p,
              } = await gr(
                e,
                c,
                a.pixelStyle,
                a.resolution,
                a.tagGroups,
                a.fps
              ),
              m = await crypto.subtle.digest(`SHA-256`, await d.arrayBuffer()),
              h = Array.from(new Uint8Array(m))
                .map(e => e.toString(16).padStart(2, `0`))
                .join(``);
            if (n.some(e => e.id === h)) continue;
            c.forEach(e => {
              e?.exactCount != null && r.set(e.id, (r.get(e.id) ?? 0) + 1);
            });
            let g = n.length + 1,
              _ = pr(a.nameTemplate, {
                collection: a.collectionName.trim(),
                edition: String(g),
              });
            (n.push({
              id: h,
              name: _,
              file: ur(d, `${dr(a.collectionName)}-${g}.png`),
              animation: f ? ur(f, `${dr(a.collectionName)}-${g}.gif`) : void 0,
              attributes: p,
              selected: !0,
            }),
              b(`Assembled ${n.length} of ${a.count} unique artworks…`));
          }
          let s = e
            .flatMap(e =>
              e.traits.filter(
                e =>
                  e.exactCount != null &&
                  (r.get(e.id) ?? 0) !== Number(e.exactCount)
              )
            )
            .map(e => e.name);
          if (n.length !== a.count)
            throw Error(
              `Only ${n.length} unique artworks could be assembled. Review the rarity, exact counts, and compatibility rules.`
            );
          if (s.length)
            throw Error(
              `Exact counts could not be met for: ${s.join(`, `)}. Review trait rules and layer appearance.`
            );
          (o(e => ({ ...e, candidates: n })),
            b(
              `${n.length} unique artworks assembled. Review the images and traits.`
            ));
        } catch (e) {
          S(
            e instanceof Error
              ? e.message
              : `Could not assemble this collection.`
          );
        } finally {
          v(!1);
        }
      }
    },
    pe = async () => {
      if (!a.collectionName.trim()) return `Add a collection name.`;
      if (!P.length) return `Select at least one artwork to continue.`;
      let e = P.map(e => e.name.trim().toLowerCase());
      if (e.some(e => !e)) return `Every selected artwork needs a name.`;
      if (new Set(e).size !== e.length)
        return `Selected artwork names must be unique.`;
      b(`Checking selected image files for duplicates…`);
      let t = new Set();
      for (let e of P) {
        let n = await crypto.subtle.digest(
            `SHA-256`,
            await e.file.arrayBuffer()
          ),
          r = Array.from(new Uint8Array(n))
            .map(e => e.toString(16).padStart(2, `0`))
            .join(``);
        if (t.has(r))
          return `Duplicate artwork detected: ${e.name}. Remove it or create a new variation.`;
        t.add(r);
      }
      return ``;
    },
    me = () => {
      let e = {
          name: a.collectionName,
          description: a.description,
          external_url: a.externalUrl || void 0,
          generatedAt: new Date().toISOString(),
          artworks: P.map((e, t) => ({
            edition: t + 1,
            name: e.name,
            description:
              e.description ??
              pr(a.descriptionTemplate, {
                collection: a.collectionName,
                edition: String(t + 1),
                description: a.description,
              }),
            image: e.file.name,
            animation_url: e.animation?.name,
            attributes: e.attributes,
          })),
        },
        t = new Blob([JSON.stringify(e, null, 2)], {
          type: `application/json`,
        }),
        n = URL.createObjectURL(t),
        r = document.createElement(`a`);
      ((r.href = n),
        (r.download = `${dr(a.collectionName)}-metadata.json`),
        r.click(),
        URL.revokeObjectURL(n));
    },
    he = async () => {
      if (!P.length) S(`Select at least one artwork to export.`);
      else {
        (v(!0), S(``), b(`Preparing artwork and metadata ZIP…`));
        try {
          let e = {},
            t = [];
          for (let [n, r] of P.entries()) {
            let i = n + 1,
              o = `${i}.${r.file.type === `image/jpeg` ? `jpg` : r.file.type === `image/gif` ? `gif` : r.file.type === `image/webp` ? `webp` : `png`}`;
            e[`images/${o}`] = new Uint8Array(await r.file.arrayBuffer());
            let s = r.animation ? `${i}.gif` : void 0;
            r.animation &&
              (e[`animation/${s}`] = new Uint8Array(
                await r.animation.arrayBuffer()
              ));
            let c = {
              edition: i,
              name: r.name,
              description:
                r.description ??
                pr(a.descriptionTemplate, {
                  collection: a.collectionName,
                  edition: String(i),
                  description: a.description,
                }),
              image: `images/${o}`,
              animation_url: s ? `animation/${s}` : void 0,
              external_url: a.externalUrl || void 0,
              attributes: r.attributes.map(e => ({
                trait_type: e.trait_type,
                value: e.value,
              })),
            };
            (t.push(c),
              (e[`metadata/${i}.json`] = Qn(JSON.stringify(c, null, 2))),
              i % 20 == 0 && b(`Preparing ${i} of ${P.length} artworks…`));
          }
          ((e[`metadata.json`] = Qn(JSON.stringify(t, null, 2))),
            (e[`collection.json`] = Qn(
              JSON.stringify(
                {
                  name: a.collectionName,
                  description: a.description,
                  external_url: a.externalUrl || void 0,
                  token_count: P.length,
                  resolution: a.resolution,
                  pixel_art: a.pixelStyle,
                },
                null,
                2
              )
            )));
          let n = new Blob([or(e, { level: 0 })], { type: `application/zip` }),
            r = URL.createObjectURL(n),
            i = document.createElement(`a`);
          ((i.href = r),
            (i.download = `${dr(a.collectionName)}-collection.zip`),
            i.click(),
            URL.revokeObjectURL(r),
            b(`Exported ${P.length} artwork files and metadata.`));
        } catch (e) {
          S(
            e instanceof Error
              ? e.message
              : `Could not export the collection ZIP.`
          );
        } finally {
          v(!1);
        }
      }
    },
    ge = async () => {
      let e = await pe();
      if (e) {
        S(e);
        return;
      }
      if (!a.collectionName.trim()) {
        S(`Add a collection name in Manage first.`);
        return;
      }
      if (!a.symbol.trim()) {
        S(`Enter your collection symbol in Manage first.`);
        return;
      }
      if (!P.length) {
        S(`Select at least one finished artwork in Preview.`);
        return;
      }
      if (
        !Number.isSafeInteger(a.totalSupply) ||
        a.totalSupply < P.length ||
        a.totalSupply > 1e7
      ) {
        S(
          `Collection supply must be at least the ${P.length} selected tokens.`
        );
        return;
      }
      const rarityTotal = Number(a.rarityMix?.high ?? 10) + Number(a.rarityMix?.medium ?? 30) + Number(a.rarityMix?.common ?? 60);
      if (rarityTotal !== 100) {
        S(`High, medium, and common rarity percentages must total 100%.`);
        return;
      }
      (v(!0), S(``));
      try {
          let e = P.map((e, t) => ({
              name: e.name.trim(),
              description:
                e.description ??
                pr(a.descriptionTemplate, {
                  collection: a.collectionName,
                  edition: String(t + 1),
                  description: a.description.trim(),
                }),
              attributes: e.attributes.map(attribute => ({ trait_type: attribute.trait_type.trim(), value: attribute.value.trim() })).filter(attribute => attribute.trait_type && attribute.value),
              file: e.file,
              animation: e.animation,
              rarityScore: Number(generationRarity(e, a.candidates)) || 0,
            })),
            i = a.collectionSlug;
          if (!i) {
            (b(`Creating your collection…`),
              (i = await n({
                name: a.collectionName.trim(),
                symbol: a.symbol.trim().toUpperCase(),
                description: a.description.trim(),
                totalSupply: a.totalSupply,
                cover: P[0].file,
              })));
            let e = { ...a, collectionSlug: i };
            (await Lt(`ai-collection`, e), o(e));
          }
          b(`Saving ${e.length} master artworks for the collection dashboard…`);
          await r(i, e, a.rarityMix, b);
          await archiveCreatorCollection(walletAddress, i, e.length);
          const items = await fetchCreatorArchive(walletAddress);
          await deleteStudioDraft(`ai-collection`);
          setArchiveItems(items);
          o(cr);
          c(`archive`);
          b(`${a.collectionName.trim()} is saved in your archive. Create a new collection, or continue its mint setup from the archive.`);
        } catch (e) {
          S(
            e instanceof Error
              ? e.message
              : `Could not prepare the collection. Retry here without creating a duplicate.`
          );
        } finally {
          v(!1);
        }
    };
  return (0, W.jsxs)(`main`, {
    className: `creator-studio-page ai-collection-studio`,
    children: [
      (0, W.jsxs)(`header`, {
        className: `creator-studio-heading`,
        children: [
          (0, W.jsxs)(`button`, {
            className: `back-link`,
            onClick: i,
            children: [(0, W.jsx)(G, { name: `arrow`, size: 15 }), ` Create`],
          }),
          (0, W.jsx)(`span`, {
            className: `eyebrow`,
            children: `CREATOR STUDIO · COLLECTION BUILDER`,
          }),
          (0, W.jsx)(`h1`, {
                  children: `Build a collection with intentional traits.`,
          }),
          (0, W.jsx)(`p`, {
                  children: `Define the collection artwork and traits, review the generated NFTs, then create the collection. Configure mint stages, dates, prices, and whitelists in collection settings.`,
          }),
        ],
      }),
      (0, W.jsx)(`nav`, {
        className: `ai-collection-tabs`,
        "aria-label": `Collection studio sections`,
        children: [
          [`manage`, `Manage`],
          [`preview`, `Review`],
          [`settings`, `Metadata`],
          [`launch`, `Publish`],
          [`archive`, `Archive${archiveItems.length ? ` · ${archiveItems.length}` : ``}`],
        ].map(([e, t]) =>
          (0, W.jsxs)(
            `button`,
            {
              className: s === e ? `is-active` : ``,
              onClick: () => c(e),
              children: [
                t,
                e === `preview` && a.candidates.length
                  ? ` · ${a.candidates.length}`
                  : ``,
              ],
            },
            e
          )
        ),
      }),
      x &&
        (0, W.jsx)(`p`, {
          className: `studio-error`,
          role: `alert`,
          children: x,
        }),
      y &&
        (0, W.jsxs)(`p`, {
          className: `ai-collection-progress`,
          role: `status`,
          children: [
            _ && (0, W.jsx)(`span`, { className: `ai-collection-spinner` }),
            y,
          ],
        }),
      s === `manage` &&
        (0, W.jsxs)(W.Fragment, {
          children: [
            (0, W.jsxs)(`section`, {
              className: `ai-collection-setup`,
              children: [
                (0, W.jsxs)(`div`, {
                  className: `ai-collection-fields`,
                  children: [
                    (0, W.jsxs)(`label`, {
                      children: [
                        `Collection name`,
                        (0, W.jsx)(`input`, {
                          value: a.collectionName,
                          maxLength: 100,
                          disabled: !!a.collectionSlug,
                          onChange: e =>
                            o(t => ({
                              ...t,
                              collectionName: e.target.value,
                            })),
                          placeholder: `e.g. Celestial Companions`,
                        }),
                      ],
                    }),
                    (0, W.jsxs)(`label`, {
                      children: [
                        `Symbol`,
                        (0, W.jsx)(`input`, {
                          value: a.symbol,
                          maxLength: 20,
                          disabled: !!a.collectionSlug,
                          onChange: e =>
                            o(t => ({
                              ...t,
                              symbol: e.target.value
                                .toUpperCase()
                                .replace(/[^A-Z0-9]/g, ``),
                            })),
                          placeholder: `Enter your symbol, e.g. ACS`,
                        }),
                      ],
                    }),
                    (0, W.jsxs)(`label`, {
                      className: `ai-collection-count`,
                      children: [
                        `Collection supply`,
                        (0, W.jsx)(`input`, {
                          type: `number`,
                          min: `1`,
                          max: `10000000`,
                          value: a.totalSupply,
                          disabled: !!a.collectionSlug,
                          onChange: e =>
                            o(t => ({
                              ...t,
                              totalSupply: e.target.value === `` ? `` : e.target.value,
                            })),
                          onBlur: () =>
                            o(t => ({
                              ...t,
                              totalSupply: Math.max(1, Math.min(1e7, Number(t.totalSupply) || 1)),
                            })),
                        }),
                        (0, W.jsx)(`small`, {
                      children: `Final mint supply. Generate up to 8 master artworks, then expand them into the full supply with individual edition metadata.`,
                        }),
                      ],
                    }),
                    (0, W.jsxs)(`label`, {
                      children: [
                        `Description`,
                        (0, W.jsx)(`textarea`, {
                          rows: 2,
                          maxLength: 600,
                          disabled: !!a.collectionSlug,
                          value: a.description,
                          onChange: e =>
                            o(t => ({ ...t, description: e.target.value })),
                          placeholder: `A short description for this collection`,
                        }),
                      ],
                    }),
                    (0, W.jsxs)(`label`, {
                      className: `ai-collection-count`,
                      children: [
                        `Artwork per batch`,
                        (0, W.jsx)(`input`, {
                          type: `number`,
                          min: `1`,
                          max: 8,
                          value: a.count,
                          onChange: e =>
                            o(t => ({
                              ...t,
                              // Let the field be cleared while editing. Clamping on
                              // every keystroke makes replacing the default (5)
                              // awkward: backspace immediately restores 1, so the
                              // next digit becomes a different value.
                              count: e.target.value === `` ? `` : Number(e.target.value),
                            })),
                          onBlur: () =>
                            o(t => ({
                              ...t,
                              count: Math.max(
                                1,
                                Math.min(
                                  8,
                                  Number(t.count) || 1
                                )
                              ),
                            })),
                        }),
                        (0, W.jsx)(`small`, {
                          children:
                            `Unique AI-generated artworks per batch · maximum 8.`,
                        }),
                      ],
                    }),
                    a.collectionSlug &&
                      (0, W.jsx)(`p`, {
                        className: `ai-collection-review__note`,
                        children: `Collection created. Its name, symbol, description, and supply are locked while you finish publishing.`,
                      }),
                  ],
                }),
                (0, W.jsx)(SupplyRarityEditor, {
                  supply: a.totalSupply,
                  mix: a.rarityMix ?? { high: 10, medium: 30, common: 60 },
                  onChange: rarityMix => o(current => ({ ...current, rarityMix })),
                }),
                (0, W.jsxs)(`div`, {
                  className: `ai-collection-mode ai-collection-mode--single`,
                  children: [
                    (0, W.jsx)(`span`, { className: `eyebrow`, children: `AI COLLECTION WORKFLOW` }),
                    (0, W.jsx)(`p`, { children: `Describe your collection once. AI generates the artwork variations, assigns the traits, and prepares their metadata in one reviewable flow.` }),
                  ],
                }),
                (0, W.jsxs)(`label`, {
                  className: `ai-collection-checkbox`,
                  children: [
                    (0, W.jsx)(`input`, {
                      type: `checkbox`,
                      checked: a.pixelStyle,
                      onChange: e =>
                        o(t => ({ ...t, pixelStyle: e.target.checked })),
                    }),
                    (0, W.jsxs)(`span`, {
                      children: [
                        (0, W.jsx)(`b`, { children: `Pixel art` }),
                        (0, W.jsx)(`small`, {
                          children: `Generate pixel artwork with crisp edges.`,
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            a.mode === `characters`
              ? (0, W.jsxs)(`section`, {
                  className: `ai-collection-builder`,
                  children: [
                    (0, W.jsxs)(`label`, {
                      className: `ai-collection-prompt`,
                      children: [
                        (0, W.jsx)(`span`, {
                          className: `eyebrow`,
                          children: `ART DIRECTION`,
                        }),
                        (0, W.jsx)(`textarea`, {
                          rows: 4,
                          maxLength: 900,
                          value: a.prompt,
                          onChange: e =>
                            o(t => ({ ...t, prompt: e.target.value })),
                          placeholder: `A friendly moon fox explorer with luminous details, a midnight-blue and lavender palette…`,
                        }),
                        (0, W.jsx)(`small`, {
                          children: `AI fills any blank trait categories, assigns a unique weighted trait mix, generates each image, then checks that image against its assigned traits.`,
                        }),
                      ],
                    }),
                    (0, W.jsx)(PromptTraitsEditor, {
                      categories: a.generationTraits ?? [],
                      onChange: generationTraits => o(current => ({ ...current, generationTraits })),
                    }),
                    (0, W.jsxs)(K, {
                      onClick: () => void ue(),
                      disabled: h || _ || a.prompt.trim().length < 8,
                      children: [
                        _
                          ? `Generating collection…`
                          : `Generate ${Math.min(8, Math.max(1, a.count))} variations`,
                        ` `,
                        (0, W.jsx)(G, { name: `spark`, size: 15 }),
                      ],
                    }),
                  ],
                })
              : a.mode === `custom`
              ? (0, W.jsxs)(`section`, {
                    className: `ai-collection-builder`,
                    children: [
                      (0, W.jsxs)(`div`, {
                        className: `ai-collection-layer-heading`,
                        children: [
                          (0, W.jsxs)(`div`, {
                            children: [
                              (0, W.jsx)(`span`, {
                                className: `eyebrow`,
                                children: `PRE-GENERATED TOKENS`,
                              }),
                              (0, W.jsx)(`h2`, {
                                children: `Import finished artwork`,
                              }),
                              (0, W.jsx)(`p`, {
                                children: `Choose a folder or ZIP with image files and optional JSON metadata. Numbered JSON sidecars are matched to image filenames.`,
                              }),
                            ],
                          }),
                          (0, W.jsxs)(`div`, {
                            className: `ai-collection-import`,
                            children: [
                              (0, W.jsxs)(`label`, {
                                className: `ai-collection-upload`,
                                children: [
                                  (0, W.jsx)(G, { name: `image`, size: 15 }),
                                  ` Import images / JSON / ZIP`,
                                  (0, W.jsx)(`input`, {
                                    type: `file`,
                                    multiple: !0,
                                    accept: `.zip,.json,image/png,image/jpeg,image/webp,image/gif,image/svg+xml`,
                                    onChange: e => {
                                      (le(e.target.files),
                                        (e.currentTarget.value = ``));
                                    },
                                  }),
                                ],
                              }),
                              (0, W.jsxs)(`label`, {
                                className: `ai-collection-upload`,
                                children: [
                                  (0, W.jsx)(G, { name: `image`, size: 15 }),
                                  ` Import folder`,
                                  (0, W.jsx)(`input`, {
                                    type: `file`,
                                    multiple: !0,
                                    webkitdirectory: ``,
                                    directory: ``,
                                    onChange: e => {
                                      (le(e.target.files),
                                        (e.currentTarget.value = ``));
                                    },
                                  }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                      (0, W.jsx)(`p`, {
                        className: `ai-collection-review__note`,
                        children: `Accepted artwork: PNG, JPEG, WebP, GIF, and SVG. Metadata can contain a name, description, image, and attributes.`,
                      }),
                    ],
                  })
                : (0, W.jsxs)(W.Fragment, {
                    children: [
                      (0, W.jsxs)(`section`, {
                        className: `ai-collection-builder`,
                        children: [
                          (0, W.jsxs)(`div`, {
                            className: `ai-collection-layer-heading`,
                            children: [
                              (0, W.jsxs)(`div`, {
                                children: [
                                  (0, W.jsx)(`span`, {
                                    className: `eyebrow`,
                                    children: `ASSET MANAGEMENT`,
                                  }),
                                  (0, W.jsx)(`h2`, {
                                    children: `Trait categories and assets`,
                                  }),
                                  (0, W.jsx)(`p`, {
                                    children: `Folder layout should be Category/Trait image. You can also upload a ZIP or add categories manually.`,
                                  }),
                                ],
                              }),
                              (0, W.jsxs)(`div`, {
                                className: `ai-collection-import`,
                                children: [
                                  (0, W.jsxs)(`label`, {
                                    className: `ai-collection-upload`,
                                    children: [
                                      (0, W.jsx)(G, {
                                        name: `image`,
                                        size: 15,
                                      }),
                                      ` Import ZIP`,
                                      (0, W.jsx)(`input`, {
                                        type: `file`,
                                        accept: `.zip`,
                                        onChange: e => {
                                          (ce(e.target.files),
                                            (e.currentTarget.value = ``));
                                        },
                                      }),
                                    ],
                                  }),
                                  (0, W.jsxs)(`label`, {
                                    className: `ai-collection-upload`,
                                    children: [
                                      (0, W.jsx)(G, {
                                        name: `image`,
                                        size: 15,
                                      }),
                                      ` Import folder`,
                                      (0, W.jsx)(`input`, {
                                        type: `file`,
                                        multiple: !0,
                                        webkitdirectory: ``,
                                        directory: ``,
                                        onChange: e => {
                                          (ce(e.target.files),
                                            (e.currentTarget.value = ``));
                                        },
                                      }),
                                    ],
                                  }),
                                ],
                              }),
                              (0, W.jsxs)(`div`, {
                                className: `ai-collection-add-layer`,
                                children: [
                                  (0, W.jsx)(`input`, {
                                    value: D,
                                    onChange: e => O(e.target.value),
                                    placeholder: `New category`,
                                    "aria-label": `New trait category`,
                                    onKeyDown: e => {
                                      e.key === `Enter` &&
                                        (e.preventDefault(), ie());
                                    },
                                  }),
                                  (0, W.jsxs)(K, {
                                    variant: `outline`,
                                    onClick: ie,
                                    children: [
                                      (0, W.jsx)(G, { name: `plus`, size: 14 }),
                                      ` Add category`,
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          }),
                          a.layers.map((e, t) =>
                            (0, W.jsxs)(
                              `div`,
                              {
                                className: `ai-collection-layer`,
                                children: [
                                  (0, W.jsxs)(`header`, {
                                    children: [
                                      (0, W.jsxs)(`div`, {
                                        children: [
                                          (0, W.jsxs)(`b`, {
                                            children: [t + 1, `. `, e.name],
                                          }),
                                          (0, W.jsxs)(`small`, {
                                            children: [
                                              e.traits.length,
                                              ` trait`,
                                              e.traits.length === 1 ? `` : `s`,
                                            ],
                                          }),
                                        ],
                                      }),
                                      (0, W.jsxs)(`div`, {
                                        className: `ai-collection-layer__tools`,
                                        children: [
                                          (0, W.jsx)(`button`, {
                                            disabled: t === 0,
                                            "aria-label": `Move ${e.name} up`,
                                            onClick: () =>
                                              o(e => {
                                                let n = e.layers.slice();
                                                return (
                                                  ([n[t - 1], n[t]] = [
                                                    n[t],
                                                    n[t - 1],
                                                  ]),
                                                  { ...e, layers: n }
                                                );
                                              }),
                                            children: `↑`,
                                          }),
                                          (0, W.jsx)(`button`, {
                                            disabled: t === a.layers.length - 1,
                                            "aria-label": `Move ${e.name} down`,
                                            onClick: () =>
                                              o(e => {
                                                let n = e.layers.slice();
                                                return (
                                                  ([n[t + 1], n[t]] = [
                                                    n[t],
                                                    n[t + 1],
                                                  ]),
                                                  { ...e, layers: n }
                                                );
                                              }),
                                            children: `↓`,
                                          }),
                                          (0, W.jsx)(`button`, {
                                            "aria-label": `Remove ${e.name}`,
                                            onClick: () =>
                                              o(t => ({
                                                ...t,
                                                layers: t.layers.filter(
                                                  t => t.id !== e.id
                                                ),
                                                rules: t.rules.filter(
                                                  t =>
                                                    !e.traits.some(
                                                      e =>
                                                        e.id === t.source ||
                                                        t.targets.includes(e.id)
                                                    )
                                                ),
                                              })),
                                            children: (0, W.jsx)(G, {
                                              name: `close`,
                                              size: 14,
                                            }),
                                          }),
                                        ],
                                      }),
                                    ],
                                  }),
                                  (0, W.jsxs)(`div`, {
                                    className: `ai-collection-layer__actions`,
                                    children: [
                                      (0, W.jsxs)(`label`, {
                                        className: `ai-collection-upload`,
                                        children: [
                                          (0, W.jsx)(G, {
                                            name: `image`,
                                            size: 15,
                                          }),
                                          ` Add trait images`,
                                          (0, W.jsx)(`input`, {
                                            type: `file`,
                                            accept: `image/png,image/jpeg,image/webp,image/gif,image/svg+xml`,
                                            multiple: !0,
                                            onChange: t => {
                                              (se(
                                                e.id,
                                                Array.from(t.target.files ?? [])
                                              ),
                                                (t.currentTarget.value = ``));
                                            },
                                          }),
                                        ],
                                      }),
                                      (0, W.jsx)(`input`, {
                                        value: T[e.id] ?? ``,
                                        onChange: t =>
                                          E(n => ({
                                            ...n,
                                            [e.id]: t.target.value,
                                          })),
                                        placeholder: `Describe an AI-generated ${e.name.toLowerCase()}`,
                                        "aria-label": `Prompt for ${e.name}`,
                                      }),
                                      (0, W.jsxs)(K, {
                                        variant: `outline`,
                                        onClick: () => void B(e),
                                        disabled:
                                          _ ||
                                          (T[e.id] ?? ``).trim().length < 8,
                                        children: [
                                          (0, W.jsx)(G, {
                                            name: `spark`,
                                            size: 13,
                                          }),
                                          ` Generate trait`,
                                        ],
                                      }),
                                    ],
                                  }),
                                  (0, W.jsxs)(`div`, {
                                    className: `ai-collection-layer-setting`,
                                    children: [
                                      (0, W.jsxs)(`label`, {
                                        children: [
                                          `Category appears in `,
                                          (0, W.jsx)(`input`, {
                                            type: `number`,
                                            min: `0`,
                                            max: `100`,
                                            value: e.appearance,
                                            onChange: t =>
                                              o(n => ({
                                                ...n,
                                                layers: n.layers.map(n =>
                                                  n.id === e.id
                                                    ? {
                                                        ...n,
                                                        appearance: Math.max(
                                                          0,
                                                          Math.min(
                                                            100,
                                                            Number(
                                                              t.target.value
                                                            ) || 0
                                                          )
                                                        ),
                                                      }
                                                    : n
                                                ),
                                              })),
                                          }),
                                          ` % of tokens`,
                                        ],
                                      }),
                                      (0, W.jsxs)(`label`, {
                                        children: [
                                          (0, W.jsx)(`input`, {
                                            type: `checkbox`,
                                            checked: e.includeMetadata,
                                            onChange: t =>
                                              o(n => ({
                                                ...n,
                                                layers: n.layers.map(n =>
                                                  n.id === e.id
                                                    ? {
                                                        ...n,
                                                        includeMetadata:
                                                          t.target.checked,
                                                      }
                                                    : n
                                                ),
                                              })),
                                          }),
                                          ` Include category in metadata`,
                                        ],
                                      }),
                                    ],
                                  }),
                                  e.traits.length > 0 &&
                                    (0, W.jsx)(`div`, {
                                      className: `ai-collection-traits`,
                                      children: e.traits.map(t =>
                                        (0, W.jsxs)(
                                          `div`,
                                          {
                                            className: `ai-collection-trait`,
                                            children: [
                                              (0, W.jsx)(br, {
                                                file: t.file,
                                                name: t.name,
                                              }),
                                              (0, W.jsx)(`input`, {
                                                "aria-label": `Trait name`,
                                                value: t.name,
                                                onChange: n =>
                                                  o(r => ({
                                                    ...r,
                                                    layers: r.layers.map(r =>
                                                      r.id === e.id
                                                        ? {
                                                            ...r,
                                                            traits:
                                                              r.traits.map(e =>
                                                                e.id === t.id
                                                                  ? {
                                                                      ...e,
                                                                      name: n
                                                                        .target
                                                                        .value,
                                                                    }
                                                                  : e
                                                              ),
                                                          }
                                                        : r
                                                    ),
                                                  })),
                                              }),
                                              (0, W.jsxs)(`label`, {
                                                children: [
                                                  `Rarity weight`,
                                                  (0, W.jsx)(`input`, {
                                                    type: `number`,
                                                    min: `0`,
                                                    max: `1000`,
                                                    value: t.weight,
                                                    onChange: n =>
                                                      o(r => ({
                                                        ...r,
                                                        layers: r.layers.map(
                                                          r =>
                                                            r.id === e.id
                                                              ? {
                                                                  ...r,
                                                                  traits:
                                                                    r.traits.map(
                                                                      e =>
                                                                        e.id ===
                                                                        t.id
                                                                          ? {
                                                                              ...e,
                                                                              weight:
                                                                                Math.max(
                                                                                  0,
                                                                                  Math.min(
                                                                                    1e3,
                                                                                    Number(
                                                                                      n
                                                                                        .target
                                                                                        .value
                                                                                    ) ||
                                                                                      0
                                                                                  )
                                                                                ),
                                                                            }
                                                                          : e
                                                                    ),
                                                                }
                                                              : r
                                                        ),
                                                      })),
                                                  }),
                                                ],
                                              }),
                                              (0, W.jsxs)(`label`, {
                                                children: [
                                                  `Exact count`,
                                                  (0, W.jsx)(`input`, {
                                                    type: `number`,
                                                    min: `0`,
                                                    max: a.count,
                                                    placeholder: `Rarity`,
                                                    value: t.exactCount ?? ``,
                                                    onChange: n =>
                                                      o(r => ({
                                                        ...r,
                                                        layers: r.layers.map(
                                                          r =>
                                                            r.id === e.id
                                                              ? {
                                                                  ...r,
                                                                  traits:
                                                                    r.traits.map(
                                                                      e =>
                                                                        e.id ===
                                                                        t.id
                                                                          ? {
                                                                              ...e,
                                                                              exactCount:
                                                                                n
                                                                                  .target
                                                                                  .value ===
                                                                                ``
                                                                                  ? null
                                                                                  : Math.max(
                                                                                      0,
                                                                                      Math.min(
                                                                                        a.count,
                                                                                        Number(
                                                                                          n
                                                                                            .target
                                                                                            .value
                                                                                        ) ||
                                                                                          0
                                                                                      )
                                                                                    ),
                                                                            }
                                                                          : e
                                                                    ),
                                                                }
                                                              : r
                                                        ),
                                                      })),
                                                  }),
                                                ],
                                              }),
                                              (0, W.jsx)(`button`, {
                                                onClick: () =>
                                                  o(n => ({
                                                    ...n,
                                                    layers: n.layers.map(n =>
                                                      n.id === e.id
                                                        ? {
                                                            ...n,
                                                            traits:
                                                              n.traits.filter(
                                                                e =>
                                                                  e.id !== t.id
                                                              ),
                                                          }
                                                        : n
                                                    ),
                                                  })),
                                                "aria-label": `Remove ${t.name}`,
                                                children: (0, W.jsx)(G, {
                                                  name: `close`,
                                                  size: 13,
                                                }),
                                              }),
                                            ],
                                          },
                                          t.id
                                        )
                                      ),
                                    }),
                                ],
                              },
                              e.id
                            )
                          ),
                          (0, W.jsxs)(K, {
                            onClick: () => void fe(),
                            disabled: _ || !a.layers.length,
                            children: [
                              _
                                ? `Generating preview set…`
                                : `Generate ${a.count} tokens`,
                              ` `,
                              (0, W.jsx)(G, { name: `spark`, size: 15 }),
                            ],
                          }),
                        ],
                      }),
                      (0, W.jsxs)(`section`, {
                        className: `ai-collection-rules`,
                        children: [
                          (0, W.jsxs)(`div`, {
                            children: [
                              (0, W.jsx)(`span`, {
                                className: `eyebrow`,
                                children: `RULES`,
                              }),
                              (0, W.jsx)(`h2`, {
                                children: `Trait compatibility`,
                              }),
                              (0, W.jsx)(`p`, {
                                children: `Prevent invalid combinations or require traits to appear together.`,
                              }),
                            ],
                          }),
                          (0, W.jsxs)(K, {
                            variant: `outline`,
                            onClick: z,
                            children: [
                              (0, W.jsx)(G, { name: `plus`, size: 14 }),
                              ` Add rule`,
                            ],
                          }),
                          a.rules.map(e =>
                            (0, W.jsxs)(
                              `div`,
                              {
                                className: `ai-collection-rule`,
                                children: [
                                  (0, W.jsxs)(`select`, {
                                    value: e.kind,
                                    onChange: t =>
                                      o(n => ({
                                        ...n,
                                        rules: n.rules.map(n =>
                                          n.id === e.id
                                            ? { ...n, kind: t.target.value }
                                            : n
                                        ),
                                      })),
                                    children: [
                                      (0, W.jsx)(`option`, {
                                        value: `exclude`,
                                        children: `Doesn’t mix with`,
                                      }),
                                      (0, W.jsx)(`option`, {
                                        value: `only`,
                                        children: `Only mixes with`,
                                      }),
                                      (0, W.jsx)(`option`, {
                                        value: `pair`,
                                        children: `Always pairs with`,
                                      }),
                                    ],
                                  }),
                                  (0, W.jsx)(`select`, {
                                    value: e.source,
                                    onChange: t =>
                                      o(n => ({
                                        ...n,
                                        rules: n.rules.map(n =>
                                          n.id === e.id
                                            ? { ...n, source: t.target.value }
                                            : n
                                        ),
                                      })),
                                    children: a.layers.flatMap(e =>
                                      e.traits.map(t =>
                                        (0, W.jsxs)(
                                          `option`,
                                          {
                                            value: t.id,
                                            children: [e.name, `: `, t.name],
                                          },
                                          t.id
                                        )
                                      )
                                    ),
                                  }),
                                  (0, W.jsx)(`select`, {
                                    multiple: !0,
                                    value: e.targets,
                                    "aria-label": `Rule target traits`,
                                    onChange: t =>
                                      o(n => ({
                                        ...n,
                                        rules: n.rules.map(n =>
                                          n.id === e.id
                                            ? {
                                                ...n,
                                                targets: Array.from(
                                                  t.target.selectedOptions,
                                                  e => e.value
                                                ),
                                              }
                                            : n
                                        ),
                                      })),
                                    children: a.layers.flatMap(t =>
                                      t.traits
                                        .filter(t => t.id !== e.source)
                                        .map(e =>
                                          (0, W.jsxs)(
                                            `option`,
                                            {
                                              value: e.id,
                                              children: [t.name, `: `, e.name],
                                            },
                                            e.id
                                          )
                                        )
                                    ),
                                  }),
                                  (0, W.jsx)(`button`, {
                                    onClick: () =>
                                      o(t => ({
                                        ...t,
                                        rules: t.rules.filter(
                                          t => t.id !== e.id
                                        ),
                                      })),
                                    children: `Remove`,
                                  }),
                                ],
                              },
                              e.id
                            )
                          ),
                        ],
                      }),
                      (0, W.jsxs)(`section`, {
                        className: `ai-collection-rules`,
                        children: [
                          (0, W.jsxs)(`div`, {
                            children: [
                              (0, W.jsx)(`span`, {
                                className: `eyebrow`,
                                children: `COLLECTION TEMPLATES`,
                              }),
                              (0, W.jsx)(`h2`, {
                                children: `Choose layer sets`,
                              }),
                              (0, W.jsx)(`p`, {
                                children: `Templates let you generate distinct token styles from selected trait layers.`,
                              }),
                            ],
                          }),
                          (0, W.jsxs)(`div`, {
                            className: `ai-collection-add-layer`,
                            children: [
                              (0, W.jsx)(`input`, {
                                value: k,
                                onChange: e => ee(e.target.value),
                                placeholder: `e.g. Day / Night`,
                                "aria-label": `New collection template`,
                              }),
                              (0, W.jsxs)(K, {
                                variant: `outline`,
                                onClick: ae,
                                children: [
                                  (0, W.jsx)(G, { name: `plus`, size: 14 }),
                                  ` Add template`,
                                ],
                              }),
                            ],
                          }),
                          a.templates.map(e =>
                            (0, W.jsxs)(
                              `div`,
                              {
                                className: `ai-collection-rule`,
                                children: [
                                  (0, W.jsx)(`b`, { children: e.name }),
                                  (0, W.jsxs)(`label`, {
                                    children: [
                                      `Weight `,
                                      (0, W.jsx)(`input`, {
                                        type: `number`,
                                        min: `0`,
                                        max: `1000`,
                                        value: e.weight,
                                        onChange: t =>
                                          o(n => ({
                                            ...n,
                                            templates: n.templates.map(n =>
                                              n.id === e.id
                                                ? {
                                                    ...n,
                                                    weight: Math.max(
                                                      0,
                                                      Math.min(
                                                        1e3,
                                                        Number(
                                                          t.target.value
                                                        ) || 0
                                                      )
                                                    ),
                                                  }
                                                : n
                                            ),
                                          })),
                                      }),
                                    ],
                                  }),
                                  (0, W.jsx)(`div`, {
                                    children: a.layers.map(t =>
                                      (0, W.jsxs)(
                                        `label`,
                                        {
                                          children: [
                                            (0, W.jsx)(`input`, {
                                              type: `checkbox`,
                                              checked: e.layerIds.includes(
                                                t.id
                                              ),
                                              onChange: n =>
                                                o(r => ({
                                                  ...r,
                                                  templates: r.templates.map(
                                                    r =>
                                                      r.id === e.id
                                                        ? {
                                                            ...r,
                                                            layerIds: n.target
                                                              .checked
                                                              ? [
                                                                  ...r.layerIds,
                                                                  t.id,
                                                                ]
                                                              : r.layerIds.filter(
                                                                  e =>
                                                                    e !== t.id
                                                                ),
                                                          }
                                                        : r
                                                  ),
                                                })),
                                            }),
                                            ` `,
                                            t.name,
                                          ],
                                        },
                                        t.id
                                      )
                                    ),
                                  }),
                                  (0, W.jsx)(`button`, {
                                    onClick: () =>
                                      o(t => ({
                                        ...t,
                                        templates: t.templates.filter(
                                          t => t.id !== e.id
                                        ),
                                      })),
                                    children: `Remove`,
                                  }),
                                ],
                              },
                              e.id
                            )
                          ),
                        ],
                      }),
                      (0, W.jsxs)(`section`, {
                        className: `ai-collection-rules`,
                        children: [
                          (0, W.jsxs)(`div`, {
                            children: [
                              (0, W.jsx)(`span`, {
                                className: `eyebrow`,
                                children: `TRAIT TAGS`,
                              }),
                              (0, W.jsx)(`h2`, {
                                children: `Group traits for metadata`,
                              }),
                              (0, W.jsx)(`p`, {
                                children: `When all selected traits appear, their tag is included in the NFT metadata.`,
                              }),
                            ],
                          }),
                          (0, W.jsxs)(`div`, {
                            className: `ai-collection-add-layer`,
                            children: [
                              (0, W.jsx)(`input`, {
                                value: A,
                                onChange: e => j(e.target.value),
                                placeholder: `e.g. Character type`,
                                "aria-label": `New tag group`,
                              }),
                              (0, W.jsxs)(K, {
                                variant: `outline`,
                                onClick: R,
                                children: [
                                  (0, W.jsx)(G, { name: `plus`, size: 14 }),
                                  ` Add tag group`,
                                ],
                              }),
                            ],
                          }),
                          a.tagGroups.map(e =>
                            (0, W.jsxs)(
                              `div`,
                              {
                                className: `ai-collection-rule`,
                                children: [
                                  (0, W.jsx)(`b`, { children: e.name }),
                                  (0, W.jsxs)(`label`, {
                                    children: [
                                      (0, W.jsx)(`input`, {
                                        type: `checkbox`,
                                        checked: e.includeMetadata,
                                        onChange: t =>
                                          o(n => ({
                                            ...n,
                                            tagGroups: n.tagGroups.map(n =>
                                              n.id === e.id
                                                ? {
                                                    ...n,
                                                    includeMetadata:
                                                      t.target.checked,
                                                  }
                                                : n
                                            ),
                                          })),
                                      }),
                                      ` Add to metadata`,
                                    ],
                                  }),
                                  (0, W.jsxs)(`div`, {
                                    children: [
                                      e.tags.map(t =>
                                        (0, W.jsxs)(
                                          `span`,
                                          {
                                            children: [
                                              t.name,
                                              ` · `,
                                              t.traitIds.length,
                                              ` traits `,
                                              (0, W.jsx)(`button`, {
                                                onClick: () =>
                                                  o(n => ({
                                                    ...n,
                                                    tagGroups: n.tagGroups.map(
                                                      n =>
                                                        n.id === e.id
                                                          ? {
                                                              ...n,
                                                              tags: n.tags.filter(
                                                                e =>
                                                                  e.id !== t.id
                                                              ),
                                                            }
                                                          : n
                                                    ),
                                                  })),
                                                children: `Remove`,
                                              }),
                                            ],
                                          },
                                          t.id
                                        )
                                      ),
                                      (0, W.jsx)(`input`, {
                                        value: M[e.id]?.name ?? ``,
                                        onChange: t =>
                                          N(n => ({
                                            ...n,
                                            [e.id]: {
                                              name: t.target.value,
                                              traitIds: n[e.id]?.traitIds ?? [],
                                            },
                                          })),
                                        placeholder: `Tag value`,
                                      }),
                                    ],
                                  }),
                                  (0, W.jsx)(`select`, {
                                    multiple: !0,
                                    "aria-label": `Traits for ${e.name}`,
                                    value: M[e.id]?.traitIds ?? [],
                                    onChange: t =>
                                      N(n => ({
                                        ...n,
                                        [e.id]: {
                                          name: n[e.id]?.name ?? ``,
                                          traitIds: Array.from(
                                            t.target.selectedOptions,
                                            e => e.value
                                          ),
                                        },
                                      })),
                                    children: a.layers.flatMap(e =>
                                      e.traits.map(t =>
                                        (0, W.jsxs)(
                                          `option`,
                                          {
                                            value: t.id,
                                            children: [e.name, `: `, t.name],
                                          },
                                          t.id
                                        )
                                      )
                                    ),
                                  }),
                                  (0, W.jsx)(K, {
                                    variant: `outline`,
                                    onClick: () => oe(e.id),
                                    children: `Add tag`,
                                  }),
                                  (0, W.jsx)(`button`, {
                                    onClick: () =>
                                      o(t => ({
                                        ...t,
                                        tagGroups: t.tagGroups.filter(
                                          t => t.id !== e.id
                                        ),
                                      })),
                                    children: `Remove group`,
                                  }),
                                ],
                              },
                              e.id
                            )
                          ),
                        ],
                      }),
                    ],
                  }),
          ],
        }),
      s === `preview` &&
        (0, W.jsxs)(`section`, {
          className: `ai-collection-review`,
          children: [
            (0, W.jsxs)(`div`, {
              className: `ai-collection-review__head`,
              children: [
                (0, W.jsxs)(`div`, {
                  children: [
                    (0, W.jsx)(`span`, {
                      className: `eyebrow`,
                      children: `TOKEN PREVIEW`,
                    }),
                    (0, W.jsxs)(`h2`, {
                      children: [
                        a.collectionName || `Your collection`,
                        ` `,
                        (0, W.jsxs)(`small`, {
                          children: [
                            P.length,
                            ` selected / `,
                            a.candidates.length,
                            ` generated`,
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
                (0, W.jsx)(K, {
                  variant: `outline`,
                  onClick: () => void L(),
                  disabled: h || _,
                  children: C || `Save draft`,
                }),
              ],
            }),
            (0, W.jsxs)(`div`, {
              className: `ai-collection-preview-tools`,
              children: [
                (0, W.jsx)(`input`, {
                  value: l,
                  onChange: e => {
                    (u(e.target.value), m(0));
                  },
                  placeholder: `Search token number, name, or trait`,
                  "aria-label": `Search tokens`,
                }),
                (0, W.jsxs)(`select`, {
                  value: d,
                  onChange: e => {
                    (f(e.target.value), m(0));
                  },
                  children: [
                    (0, W.jsx)(`option`, { value: ``, children: `All traits` }),
                    Array.from(
                      new Set(
                        a.candidates.flatMap(e =>
                          e.attributes.map(e => `${e.trait_type}:${e.value}`)
                        )
                      )
                    ).map(e =>
                      (0, W.jsx)(
                        `option`,
                        { value: e, children: e.replace(`:`, ` · `) },
                        e
                      )
                    ),
                  ],
                }),
                (0, W.jsx)(K, {
                  variant: `outline`,
                  onClick: () => {
                    (u(``), f(``), m(0));
                  },
                  children: `Clear`,
                }),
              ],
            }),
            a.candidates.length
              ? (0, W.jsxs)(W.Fragment, {
                  children: [
                    (0, W.jsx)(`div`, {
                      className: `ai-collection-candidate-grid`,
                      children: re.map(e =>
                        (0, W.jsx)(
                          yr,
                          {
                            candidate: e,
                            onToggle: () =>
                              o(t => ({
                                ...t,
                                candidates: t.candidates.map(t =>
                                  t.id === e.id
                                    ? { ...t, selected: !t.selected }
                                    : t
                                ),
                              })),
                            onRename: t =>
                              o(n => ({
                                ...n,
                                candidates: n.candidates.map(n =>
                                  n.id === e.id ? { ...n, name: t } : n
                                ),
                              })),
                            onRemove: () =>
                              o(t => ({
                                ...t,
                                candidates: t.candidates.filter(
                                  t => t.id !== e.id
                                ),
                              })),
                            onAnalyze: () => void de(e),
                            onVerify: () => void checkAssignedTraits(e),
                            analyzing: te.includes(e.id),
                            rarityScore: generationRarity(e, a.candidates),
                            onAttributesChange: t =>
                              o(n => ({
                                ...n,
                                candidates: n.candidates.map(n =>
                                  n.id === e.id ? { ...n, attributes: t, traitAudit: undefined } : n
                                ),
                              })),
                          },
                          e.id
                        )
                      ),
                    }),
                    (0, W.jsxs)(`div`, {
                      className: `ai-collection-preview-tools`,
                      children: [
                        (0, W.jsx)(K, {
                          variant: `outline`,
                          disabled: p === 0,
                          onClick: () => m(e => Math.max(0, e - 1)),
                          children: `Previous`,
                        }),
                        (0, W.jsx)(`small`, {
                          children: I.length
                            ? `${p * 48 + 1}–${Math.min((p + 1) * 48, I.length)} of ${I.length}`
                            : `No matching tokens`,
                        }),
                        (0, W.jsx)(K, {
                          variant: `outline`,
                          disabled: (p + 1) * 48 >= I.length,
                          onClick: () => m(e => e + 1),
                          children: `Next`,
                        }),
                      ],
                    }),
                  ],
                })
              : (0, W.jsxs)(`div`, {
                  className: `ai-collection-empty`,
                  children: [
                    (0, W.jsx)(G, { name: `image`, size: 28 }),
                    (0, W.jsx)(`b`, { children: `No preview set yet` }),
                    (0, W.jsx)(`span`, {
                      children: `Generate a set in Manage, then filter and review each token here.`,
                    }),
                  ],
                }),
            (0, W.jsxs)(`details`, {
              className: `ai-collection-metadata-preview`,
              children: [
                (0, W.jsx)(`summary`, {
                  children: `Metadata preview (all generated artworks)`,
                }),
                (0, W.jsx)(`pre`, {
                  children: JSON.stringify(
                    P.map((e, t) => ({
                      name: e.name,
                      description: a.description,
                      image: e.file.name,
                      animation_url: e.animation?.name,
                      edition: t + 1,
                      attributes: e.attributes,
                    })),
                    null,
                    2
                  ),
                }),
              ],
            }),
          ],
        }),
      s === `settings` &&
        (0, W.jsxs)(`section`, {
          className: `ai-collection-settings`,
          children: [
            (0, W.jsxs)(`div`, {
              children: [
                (0, W.jsx)(`span`, { className: `eyebrow`, children: `AUTOMATIC METADATA` }),
                (0, W.jsx)(`h2`, { children: `Metadata is created for you` }),
                (0, W.jsx)(`p`, { children: `No templates to fill in. Each NFT gets its collection name and edition number, your collection description, its generated traits, and rarity.` }),
              ],
            }),
            (0, W.jsxs)(`div`, {
              className: `ai-collection-auto-metadata`,
              children: [
                (0, W.jsxs)(`p`, { children: [(0, W.jsx)(`b`, { children: `Name` }), ` · ${a.collectionName || `Collection`} #1, #2, #3…`] }),
                (0, W.jsxs)(`p`, { children: [(0, W.jsx)(`b`, { children: `Description` }), ` · Uses the collection description from Manage.`] }),
                (0, W.jsxs)(`p`, { children: [(0, W.jsx)(`b`, { children: `Attributes` }), ` · Generated from each artwork’s assigned traits and rarity.`] }),
                (0, W.jsxs)(`p`, { children: [(0, W.jsx)(`b`, { children: `Reveal` }), ` · After creating the collection, open its collection page. The creator’s Artwork reveal control is above the mint timeline.`] }),
              ],
            }),
          ],
        }),      s === `archive` &&
        (0, W.jsxs)(`section`, {
          className: `ai-collection-archive`,
          children: [
            (0, W.jsxs)(`div`, {
              children: [
                (0, W.jsx)(`span`, { className: `eyebrow`, children: `YOUR COLLECTION ARCHIVE` }),
                (0, W.jsx)(`h2`, { children: `Saved collections` }),
                (0, W.jsx)(`p`, { children: `Completed collections stay here until you are ready to configure mint stages and launch. The paid download will be one complete ZIP with all artwork and animations, metadata for every edition, collection details, trait and rarity data, plus a manifest.` }),
              ],
            }),
            archiveLoading
              ? (0, W.jsx)(`p`, { className: `ai-collection-archive__empty`, children: `Loading your archive…` })
              : archiveItems.length
                ? (0, W.jsx)(`div`, {
                    className: `ai-collection-archive__list`,
                    children: archiveItems.map(item => (0, W.jsxs)(`article`, {
                      className: `ai-collection-archive__item`,
                      children: [
                        (0, W.jsxs)(`div`, {
                          children: [
                            (0, W.jsx)(`span`, { className: `eyebrow`, children: `ARCHIVED COLLECTION` }),
                            (0, W.jsx)(`h3`, { children: item.name }),
                            (0, W.jsxs)(`p`, { children: [item.symbol, ` · `, Number(item.total_supply ?? 0).toLocaleString(), ` editions · `, Number(item.artwork_count ?? 0).toLocaleString(), ` master artworks`] }),
                            (0, W.jsxs)(`small`, { children: [`Saved `, new Date(item.archived_at).toLocaleDateString()] }),
                          ],
                        }),
                        (0, W.jsxs)(`div`, {
                          className: `ai-collection-archive__actions`,
                          children: [
                            (0, W.jsxs)(K, { onClick: () => openDashboard(item.collection_slug), children: [`Continue mint setup `, (0, W.jsx)(G, { name: `arrow`, size: 14 })] }),
                            (0, W.jsx)(K, { variant: `outline`, disabled: !0, title: `The complete collection ZIP will be available on a paid plan.`, children: `Download complete ZIP · paid plan` }),
                          ],
                        }),
                      ],
                    }, item.collection_slug)),
                  })
                : (0, W.jsxs)(`p`, { className: `ai-collection-archive__empty`, children: [`No completed collections yet. Create one from `, (0, W.jsx)(`button`, { onClick: () => c(`manage`), children: `Manage` }), ` and it will be saved here.`] }),
          ],
        }),      s === `launch` &&
        (0, W.jsxs)(`section`, {
          className: `ai-collection-launch`,
          children: [
            (0, W.jsxs)(`div`, {
              children: [
                (0, W.jsx)(`span`, {
                  className: `eyebrow`,
                    children: `CREATE COLLECTION`,
                }),
                (0, W.jsx)(`h2`, {
                  children: a.collectionSlug
                    ? `${a.collectionName} · ${a.launchComplete ? `Ready` : `Continue setup`}`
                    : `Create from this studio`,
                }),
                (0, W.jsx)(`p`, {
                  children: `Create the collection and save its artwork here. Then set mint stages, dates, prices, and whitelists in collection settings.`,
                }),
              ],
            }),
            (0, W.jsxs)(`div`, {
              className: `ai-collection-launch__summary`,
              children: [
                (0, W.jsxs)(`b`, { children: [P.length, ` selected master artworks`] }),
                (0, W.jsxs)(`span`, {
                  children: [
                    a.totalSupply.toLocaleString(),
                    ` collection supply · `,
                    a.resolution,
                    ` × `,
                    a.resolution,
                  ],
                }),
                (0, W.jsx)(`span`, { children: `Rarity mix: ${getRarityTierCounts(a.totalSupply, a.rarityMix ?? { high: 10, medium: 30, common: 60 }).high.toLocaleString()} high · ${getRarityTierCounts(a.totalSupply, a.rarityMix ?? { high: 10, medium: 30, common: 60 }).medium.toLocaleString()} medium · ${getRarityTierCounts(a.totalSupply, a.rarityMix ?? { high: 10, medium: 30, common: 60 }).common.toLocaleString()} common. Master artworks repeat to fill supply; each edition gets its own rarity metadata.` }),
              ],
            }),
            (0, W.jsxs)(K, {
              onClick: () => a.launchComplete && a.collectionSlug ? openDashboard(a.collectionSlug) : void ge(),
              disabled:
                _ || (!a.launchComplete && !P.length) || (!a.launchComplete && !a.collectionName.trim()),
              children: [
                _
                  ? a.collectionSlug
                    ? `Saving artwork…`
                    : `Creating collection…`
                  : a.launchComplete
                    ? `Open collection dashboard`
                    : a.collectionSlug ? `Retry saving artwork` : `Create collection`,
                ` `,
                (0, W.jsx)(G, { name: `arrow`, size: 15 }),
              ],
            }),
            a.collectionSlug && (0, W.jsx)(K, { variant: `outline`, onClick: () => openDashboard(a.collectionSlug), children: `Open collection dashboard` }),
            (0, W.jsx)(`small`, {
              children: a.launchComplete
                ? `Collection and artwork are saved. Set mint stages, dates, prices, and whitelists in collection settings.`
                : `This step creates the collection and saves its reviewed artwork. Mint stages and prices are configured afterward in collection settings.`,
            }),
          ],
        }),
    ],
  });
}
export { xr as AiCollectionStudioPage };
