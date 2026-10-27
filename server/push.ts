import webpush from 'web-push'
import { ensureSchema, query } from './db.js'

const publicKey = process.env.WEB_PUSH_PUBLIC_KEY?.trim() ?? ''
const privateKey = process.env.WEB_PUSH_PRIVATE_KEY?.trim() ?? ''
const subject = process.env.WEB_PUSH_SUBJECT?.trim() || 'https://stelanova.vercel.app/'
const pushReady = Boolean(publicKey && privateKey)

if (pushReady) webpush.setVapidDetails(subject, publicKey, privateKey)

export function browserPushConfig() {
  return { enabled: pushReady, publicKey: pushReady ? publicKey : null }
}

export async function sendBrowserPush(wallet: string, payload: { title: string; body: string; url?: string }) {
  if (!pushReady || !/^G[A-Z2-7]{55}$/.test(wallet)) return
  const subscriptions = await query<{ endpoint: string; p256dh: string; auth: string }[]>(
    'SELECT endpoint, p256dh, auth FROM browser_push_subscriptions WHERE LOWER(wallet_address) = LOWER(?)',
    [wallet],
  )
  const message = JSON.stringify({
    title: payload.title.slice(0, 100),
    body: payload.body.slice(0, 240),
    url: payload.url && payload.url.startsWith('/') ? payload.url : '/account',
  })
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        message,
        { TTL: 3600, urgency: 'normal' },
      )
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode ?? 0)
      if (statusCode === 404 || statusCode === 410) {
        await query('DELETE FROM browser_push_subscriptions WHERE endpoint = ?', [subscription.endpoint]).catch(() => undefined)
      }
    }
  }))
}

export async function notifyUser(wallet: string, kind: string, title: string, body: string, url = '/account') {
  if (!/^G[A-Z2-7]{55}$/.test(wallet)) return
  await ensureSchema()
  const safeUrl = url.startsWith('/') && !url.startsWith('//') ? url.slice(0, 2048) : '/account'
  await query('INSERT INTO notifications (wallet_address, kind, title, body, action_url) VALUES (?, ?, ?, ?, ?)', [wallet, kind, title, body, safeUrl])
  await sendBrowserPush(wallet, { title, body, url: safeUrl }).catch(() => undefined)
}
