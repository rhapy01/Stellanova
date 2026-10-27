type TelegramWebApp = {
  initData?: string
  ready?: () => void
  expand?: () => void
  setHeaderColor?: (color: string) => void
  setBackgroundColor?: (color: string) => void
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void
  BackButton?: {
    show: () => void
    hide: () => void
    onClick: (callback: () => void) => void
    offClick: (callback: () => void) => void
  }
  HapticFeedback?: { impactOccurred: (style: 'light' | 'medium' | 'heavy') => void }
  isVersionAtLeast?: (version: string) => boolean
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

export function telegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null
}

export function initializeTelegramMiniApp(): boolean {
  const webApp = telegramWebApp()
  if (!webApp) return false

  // initDataUnsafe is intentionally never used as an identity or authorization source.
  webApp.ready?.()
  webApp.expand?.()
  webApp.setHeaderColor?.('#ffffff')
  webApp.setBackgroundColor?.('#ffffff')
  document.documentElement.dataset.telegramMiniApp = 'true'
  return true
}

export function openCurrentPageInBrowser(): void {
  const webApp = telegramWebApp()
  if (webApp?.openLink) webApp.openLink(window.location.href)
  else window.open(window.location.href, '_blank', 'noopener,noreferrer')
}
