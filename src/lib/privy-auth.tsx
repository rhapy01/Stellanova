import { createContext, lazy, Suspense, useContext, type ReactNode } from 'react'
import type { StellarWallet } from './stellar'

export type StellarAuthState = {
  configured: boolean
  ready: boolean
  authenticated: boolean
  wallet: StellarWallet | null
  error: string
  login: () => Promise<void>
  logout: () => Promise<void>
}

const emptyState: StellarAuthState = {
  configured: false,
  ready: true,
  authenticated: false,
  wallet: null,
  error: '',
  login: async () => undefined,
  logout: async () => undefined,
}

const StellarAuthContext = createContext<StellarAuthState>(emptyState)
const PrivyWalletProvider = lazy(() => import('./privy-auth-enabled'))
const appId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined

export function StellarAuthProvider({ children }: { children: ReactNode }) {
  if (!appId) return <StellarAuthContext.Provider value={emptyState}>{children}</StellarAuthContext.Provider>
  const loadingState = { ...emptyState, configured: true, ready: false }
  return <Suspense fallback={<StellarAuthContext.Provider value={loadingState}>{children}</StellarAuthContext.Provider>}>
    <PrivyWalletProvider appId={appId} context={StellarAuthContext}>{children}</PrivyWalletProvider>
  </Suspense>
}

export function useStellarAuth() {
  return useContext(StellarAuthContext)
}
