import posthog from 'posthog-js'

const key = import.meta.env.VITE_POSTHOG_KEY?.trim()
const host = import.meta.env.VITE_POSTHOG_HOST?.trim() || 'https://us.i.posthog.com'

const allowedEvents = new Set([
  'page_viewed', 'account_created', 'studio_opened', 'artwork_generation_started', 'artwork_generation_completed',
  'artwork_generation_failed', 'post_published', 'collection_created', 'mint_confirmed',
  'marketplace_action_confirmed', 'referral_link_copied', 'referral_link_shared', 'referral_attributed',
])

if (key && import.meta.env.PROD) {
  posthog.init(key, {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    persistence: 'memory',
    person_profiles: 'never',
    before_send: (event) => {
      if (!event || !allowedEvents.has(event.event)) return null
      // Keep only explicitly approved, low-cardinality product properties.
      const props = event.properties ?? {}
      const clean: Record<string, string | number | boolean> = {}
      for (const name of ['page_type', 'studio', 'result', 'flow', 'network', 'quantity', 'destination']) {
        const value = props[name]
        if (typeof value === 'string' && value.length <= 40) clean[name] = value
        else if (typeof value === 'number' && Number.isFinite(value)) clean[name] = value
        else if (typeof value === 'boolean') clean[name] = value
      }
      event.properties = { ...clean, $current_url: undefined, $pathname: undefined, $referrer: undefined }
      return event
    },
  })
}

export function trackProductEvent(event: string, properties: Record<string, string | number | boolean> = {}) {
  if (!key || !import.meta.env.PROD || !allowedEvents.has(event)) return
  const safe: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(properties)) {
    if (!['page_type', 'studio', 'result', 'flow', 'network', 'quantity', 'destination'].includes(name)) continue
    if (typeof value === 'string' && value.length <= 40 || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') safe[name] = value
  }
  posthog.capture(event, safe)
}
