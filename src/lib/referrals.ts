const storageKey = 'stellanova:pending-referral'
const validCode = /^[a-f0-9]{16}$/i

export function pendingReferralCode(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('ref')?.trim() ?? ''
  if (validCode.test(fromUrl)) {
    try { window.localStorage.setItem(storageKey, JSON.stringify({ code: fromUrl.toUpperCase(), savedAt: Date.now() })) } catch { /* Storage may be disabled. */ }
    params.delete('ref')
    const query = params.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
    return fromUrl.toUpperCase()
  }
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null') as { code?: string; savedAt?: number } | null
    if (saved && validCode.test(saved.code ?? '') && Date.now() - Number(saved.savedAt) < 30 * 24 * 60 * 60_000) return saved.code!.toUpperCase()
    window.localStorage.removeItem(storageKey)
  } catch { /* Invalid or unavailable local storage. */ }
  return null
}

export function clearPendingReferralCode() {
  try { window.localStorage.removeItem(storageKey) } catch { /* Storage may be disabled. */ }
}
