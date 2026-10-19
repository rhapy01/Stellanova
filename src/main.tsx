import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { StellarAuthProvider } from './lib/privy-auth'
import './styles.css'

async function clearDevelopmentServiceWorkerState() {
  if (!('serviceWorker' in navigator) || import.meta.env.PROD) return
  const registrations = await navigator.serviceWorker.getRegistrations()
  await Promise.all(registrations.map((registration) => registration.unregister()))
  if ('caches' in window) {
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => caches.delete(key)))
  }
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => undefined)
  })
}

void clearDevelopmentServiceWorkerState().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <StellarAuthProvider><App /></StellarAuthProvider>
    </StrictMode>,
  )
})
