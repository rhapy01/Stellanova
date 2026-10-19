import { useContext, useEffect, useMemo, useRef, useState, type Context, type ReactNode } from 'react'
import { PrivyProvider, usePrivy, type User } from '@privy-io/react-auth'
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains'
import { authenticatePrivyWallet } from './backend'
import { setPrivyRawSigner, STELLAR_NETWORK, STELLAR_NETWORK_PASSPHRASE, type StellarWallet } from './stellar'
import type { StellarAuthState } from './privy-auth'

export default function PrivyWalletProvider({ appId, context, children }: { appId: string; context: Context<StellarAuthState>; children: ReactNode }) {
  return <PrivyProvider appId={appId} config={{ loginMethods: ['email'] }}><PrivyWalletBridge context={context}>{children}</PrivyWalletBridge></PrivyProvider>
}

function findStellarWallet(user: User | null): { address: string } | null {
  const linked = user?.linkedAccounts.find((account) => account.type === 'wallet'
    && 'chainType' in account && account.chainType === 'stellar'
    && 'walletClientType' in account && account.walletClientType === 'privy')
  return linked && 'address' in linked ? { address: linked.address } : null
}

function PrivyWalletBridge({ context, children }: { context: Context<StellarAuthState>; children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy()
  const { createWallet } = useCreateWallet()
  const { signRawHash } = useSignRawHash()
  const [wallet, setWallet] = useState<StellarWallet | null>(null)
  const [error, setError] = useState('')
  const provisioning = useRef(false)
  const signerRef = useRef(signRawHash)
  signerRef.current = signRawHash

  useEffect(() => {
    setPrivyRawSigner(async (address, hash) => {
      const result = await signerRef.current({ address, chainType: 'stellar', hash: hash as `0x${string}` })
      return result.signature
    })
    return () => setPrivyRawSigner(null)
  }, [])

  useEffect(() => {
    if (!ready || !authenticated || !user || provisioning.current) return
    provisioning.current = true
    void (async () => {
      try {
        setError('')
        const existing = findStellarWallet(user)
        const created = existing ?? (await createWallet({ chainType: 'stellar' })).wallet
        // Establish the server session before exposing the wallet to the app.
        // Account and profile requests run as soon as the wallet is set, so
        // publishing it earlier races those requests against authentication.
        const accessToken = await getAccessToken()
        if (!accessToken) throw new Error('Privy did not return an authenticated session')
        const verifiedWallet = await authenticatePrivyWallet(accessToken)
        if (verifiedWallet.address !== created.address) throw new Error('The verified Stellar wallet does not match this email account')
        setWallet({ address: created.address, network: STELLAR_NETWORK, networkPassphrase: STELLAR_NETWORK_PASSPHRASE, provider: 'Privy' })
      } catch (cause) {
        setWallet(null)
        setError(cause instanceof Error ? cause.message : 'Could not create your Stellar wallet')
      } finally {
        provisioning.current = false
      }
    })()
  }, [ready, authenticated, user, createWallet, getAccessToken])

  useEffect(() => {
    if (ready && !authenticated) setWallet(null)
  }, [ready, authenticated])

  const value = useMemo<StellarAuthState>(() => ({
    configured: true,
    ready,
    authenticated,
    wallet,
    error,
    login: async () => { await login({ loginMethods: ['email'] }) },
    logout: async () => { setWallet(null); await logout() },
  }), [ready, authenticated, wallet, error, login, logout])

  const Provider = context.Provider
  return <Provider value={value}>{children}</Provider>
}
