import freighterApi from '@stellar/freighter-api'
import { Buffer } from 'buffer'
import { Networks } from '@stellar/stellar-sdk'

export type StellarNetwork = 'PUBLIC' | 'TESTNET' | 'FUTURENET' | 'STANDALONE'

export type WalletProviderName = 'Freighter' | 'FreighterMobile' | 'MetaMask' | 'Privy'

export type StellarWallet = {
  address: string
  network: StellarNetwork
  networkPassphrase: string
  provider: WalletProviderName
}

export const STELLAR_NETWORK: StellarNetwork = (import.meta.env.VITE_STELLAR_NETWORK ?? 'TESTNET') as StellarNetwork
export const STELLAR_NETWORK_PASSPHRASE = STELLAR_NETWORK === 'PUBLIC' ? Networks.PUBLIC : Networks.TESTNET
export const SOROBAN_RPC_URL = import.meta.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org'
export const STELLAR_EXPLORER_URL = STELLAR_NETWORK === 'PUBLIC' ? 'https://stellar.expert/explorer/public' : 'https://stellar.expert/explorer/testnet'

const walletConnectProjectId = import.meta.env.VITE_STELLAR_WALLETCONNECT_PROJECT_ID?.trim()
let walletConnectModule: import('@creit.tech/stellar-wallets-kit/modules/wallet-connect').WalletConnectModule | null = null
let walletConnectKitReady: Promise<void> | null = null

async function getFreighterMobileWalletConnect() {
  if (!walletConnectProjectId) {
    throw new Error('Freighter Mobile needs WalletConnect to connect, but NovaMarket is missing its WalletConnect project ID. Configure VITE_STELLAR_WALLETCONNECT_PROJECT_ID in Vercel to enable mobile wallet connections.')
  }
  if (!walletConnectKitReady) {
    walletConnectKitReady = (async () => {
      const [{ StellarWalletsKit }, { WalletConnectModule, WalletConnectTargetChain }] = await Promise.all([
        import('@creit.tech/stellar-wallets-kit/sdk'),
        import('@creit.tech/stellar-wallets-kit/modules/wallet-connect'),
      ])
      walletConnectModule = new WalletConnectModule({
        projectId: walletConnectProjectId,
        metadata: {
          name: 'NovaMarket',
          description: 'Social NFT marketplace on Stellar',
          url: window.location.origin,
          icons: [`${window.location.origin}/icon-512.png`],
        },
        allowedChains: [STELLAR_NETWORK === 'PUBLIC' ? WalletConnectTargetChain.PUBLIC : WalletConnectTargetChain.TESTNET],
      })
      StellarWalletsKit.init({
        modules: [walletConnectModule],
        selectedWalletId: 'wallet_connect',
        network: STELLAR_NETWORK_PASSPHRASE,
      })
    })().catch((error) => {
      walletConnectKitReady = null
      throw error
    })
  }
  await walletConnectKitReady
  if (!walletConnectModule) throw new Error('Freighter Mobile connection could not be initialized')
  // WalletConnect initializes its SignClient asynchronously after module construction.
  for (let attempt = 0; attempt < 40 && !(await walletConnectModule.isAvailable()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!(await walletConnectModule.isAvailable())) throw new Error('WalletConnect did not initialize. Check your connection and try again.')
  return import('@creit.tech/stellar-wallets-kit/sdk').then(({ StellarWalletsKit }) => StellarWalletsKit)
}

type WalletConnectSession = Awaited<ReturnType<NonNullable<typeof walletConnectModule>['getSessions']>>[number]

async function getMobileWalletSession(address: string, networkPassphrase: string) {
  const kit = await getFreighterMobileWalletConnect()
  const module = walletConnectModule
  if (!module) throw new Error('Varial wallet connection is not initialized. Reconnect and try again.')
  const chainId = networkPassphrase === Networks.PUBLIC ? 'stellar:pubnet' as const : 'stellar:testnet' as const
  const findSession = async () => (await module.getSessions()).find((session: WalletConnectSession) =>
    session.namespaces.stellar?.accounts?.some((account) => account.toLowerCase().endsWith(`:${address.toLowerCase()}`)),
  )
  let session = await findSession()
  if (!session) {
    // Wallet app handoffs can reload the tab and clear the SDK's in-memory
    // address-to-topic map. Re-pair only when the persisted session is absent.
    const connected = await kit.fetchAddress()
    if (connected.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error('Varial connected a different Stellar account. Choose the same account used to sign in, then retry.')
    }
    session = await findSession()
  }
  if (!session) throw new Error('Varial is connected, but its WalletConnect session is unavailable. Reconnect Varial and try again.')
  return { module, topic: session.topic, chainId }
}

async function requestMobileWallet<T>(address: string, networkPassphrase: string, request: { method: string; params: Record<string, string> }): Promise<T> {
  const first = await getMobileWalletSession(address, networkPassphrase)
  const send = (topic: string, chainId: string) => first.module.signClient.request({ topic, chainId, request }) as Promise<T>
  try {
    return await send(first.topic, first.chainId)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (!/no matching key|no session exists|no matching key/i.test(message)) throw cause
    // Some mobile wallet handoffs leave an expired WalletConnect topic in
    // storage. Remove it and establish a fresh pairing before retrying once.
    await first.module.closeSession(first.topic).catch(() => undefined)
    const kit = await getFreighterMobileWalletConnect()
    kit.setWallet('wallet_connect')
    const connected = await kit.fetchAddress()
    if (connected.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error('Varial returned a different Stellar account while reconnecting. Choose the account you signed in with.')
    }
    const replacement = (await first.module.getSessions()).find((session: WalletConnectSession) =>
      session.topic !== first.topic
      && session.namespaces.stellar?.accounts?.some((account) => account.toLowerCase().endsWith(`:${address.toLowerCase()}`)),
    )
    if (!replacement) throw new Error('Varial did not restore a fresh WalletConnect session. Reconnect the wallet and retry.')
    return send(replacement.topic, first.chainId)
  }
}

function isFreighterMobileContext() {
  if (typeof window === 'undefined') return false
  const stellar = (window as Window & { stellar?: { provider?: string; platform?: string } }).stellar
  return (stellar?.provider === 'freighter' && stellar?.platform === 'mobile')
    || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

export async function connectFreighter(): Promise<StellarWallet> {
  if (isFreighterMobileContext()) {
    const kit = await getFreighterMobileWalletConnect()
    kit.setWallet('wallet_connect')
    const { address } = await kit.fetchAddress()
    if (!address) throw new Error('Freighter Mobile did not return a Stellar address')
    await getMobileWalletSession(address, STELLAR_NETWORK_PASSPHRASE)
    return {
      address,
      network: STELLAR_NETWORK,
      networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
      provider: 'FreighterMobile',
    }
  } else {
    let connection: Awaited<ReturnType<typeof freighterApi.isConnected>>
    try {
      connection = await freighterApi.isConnected()
    } catch {
      throw new Error('Freighter was not detected. Open NovaMarket in Freighter’s in-app browser, or use the Freighter browser extension.')
    }
    if (connection.error) throw new Error(connection.error.message || 'Freighter could not be reached')
    if (!connection.isConnected) throw new Error('Freighter was not detected. Open NovaMarket in Freighter’s in-app browser, or use the Freighter browser extension.')
  }

  const addressResult = await freighterApi.requestAccess()
  if (addressResult.error) throw new Error(addressResult.error.message || 'Freighter access was not approved')
  const networkResult = await freighterApi.getNetworkDetails()
  if (networkResult.error) throw new Error(networkResult.error.message || 'Freighter did not return a network')
  if (!addressResult.address) throw new Error('Freighter returned an empty Stellar address')
  if (networkResult.network !== STELLAR_NETWORK) {
    const expected = STELLAR_NETWORK === 'PUBLIC' ? 'Stellar Mainnet' : 'Stellar Testnet'
    throw new Error(`Switch Freighter to ${expected} before signing NovaMarket transactions`)
  }

  return {
    address: addressResult.address,
    network: networkResult.network as StellarNetwork,
    networkPassphrase: networkResult.networkPassphrase,
    provider: 'Freighter',
  }
}

let metaMaskAdapter: import('@metamask/connect-stellar').MetaMaskStellarAdapter | null = null

async function getMetaMaskAdapter() {
  if (!metaMaskAdapter) {
    const { MetaMaskStellarAdapter } = await import('@metamask/connect-stellar')
    metaMaskAdapter = new MetaMaskStellarAdapter()
  }
  return metaMaskAdapter
}

export async function connectMetaMaskStellar(): Promise<StellarWallet> {
  if (STELLAR_NETWORK !== 'PUBLIC') {
    throw new Error('MetaMask’s Stellar wallet currently supports Mainnet only. NovaMarket is configured for Testnet.')
  }
  const adapter = await getMetaMaskAdapter()
  const access = await adapter.requestAccess()
  if (access.error) throw new Error(access.error.message || 'MetaMask access was not approved')
  const network = await adapter.getNetwork()
  if (network.error) throw new Error(network.error.message || 'MetaMask did not return a Stellar network')
  if (network.networkPassphrase !== Networks.PUBLIC) {
    throw new Error('Switch MetaMask to Stellar Mainnet before using NovaMarket.')
  }
  if (!access.address) throw new Error('MetaMask returned an empty Stellar address')
  return { address: access.address, network: 'PUBLIC', networkPassphrase: network.networkPassphrase, provider: 'MetaMask' }
}

export async function disconnectMetaMaskStellar() {
  if (!metaMaskAdapter) return
  const result = await metaMaskAdapter.disconnect()
  if (result.error) throw new Error(result.error.message || 'MetaMask could not disconnect')
  metaMaskAdapter = null
}

let privyRawSigner: ((address: string, hash: string) => Promise<string>) | null = null

export function setPrivyRawSigner(signer: ((address: string, hash: string) => Promise<string>) | null) {
  privyRawSigner = signer
}

export async function signStellarTransaction(transactionXdr: string, address: string, networkPassphrase: string = STELLAR_NETWORK_PASSPHRASE, provider?: WalletProviderName) {
  if (provider === 'Privy') {
    if (!privyRawSigner) throw new Error('Sign in with your email wallet before signing')
    const transaction = (await import('@stellar/stellar-sdk')).TransactionBuilder.fromXDR(transactionXdr, networkPassphrase)
    const txHash = Buffer.from(transaction.hash()).toString('hex')
    const signature = await privyRawSigner(address, `0x${txHash}`)
    transaction.addSignature(address, Buffer.from(signature.replace(/^0x/, ''), 'hex').toString('base64'))
    return transaction.toXDR()
  }
  if (provider === 'MetaMask') {
    if (networkPassphrase !== Networks.PUBLIC) throw new Error('MetaMask’s Stellar adapter currently supports Mainnet transactions only.')
    const signed = await (await getMetaMaskAdapter()).signTransaction(transactionXdr, { address, networkPassphrase })
    if (signed.error) throw new Error(signed.error.message || 'MetaMask rejected the Stellar transaction')
    if (signed.signerAddress !== address) throw new Error('MetaMask signed with a different Stellar account. Reconnect the intended account.')
    return signed.signedTxXdr
  }
  if (provider === 'FreighterMobile') {
    const signed = await requestMobileWallet<{ signedXDR: string; signerAddress?: string }>(address, networkPassphrase, { method: 'stellar_signXDR', params: { xdr: transactionXdr } })
    if (signed.signerAddress && signed.signerAddress !== address) throw new Error('Varial signed with a different Stellar account. Reconnect the intended account.')
    return signed.signedXDR
  }
  const signed = await freighterApi.signTransaction(transactionXdr, { address, networkPassphrase: networkPassphrase as Networks })
  if (signed.error) throw new Error(signed.error.message || 'The Stellar wallet rejected the transaction')
  return signed.signedTxXdr
}

export async function signWalletChallenge(message: string, address: string, networkPassphrase: string, provider: WalletProviderName = 'Freighter') {
  if (provider === 'MetaMask') {
    if (networkPassphrase !== Networks.PUBLIC) throw new Error('MetaMask’s Stellar adapter currently supports Mainnet signatures only.')
    const result = await (await getMetaMaskAdapter()).signMessage(message, { address, networkPassphrase })
    if (result.error) throw new Error(result.error.message || 'MetaMask rejected the sign-in request')
    if (!result.signedMessage || result.signerAddress !== address) throw new Error('MetaMask did not sign the expected sign-in challenge')
    return result.signedMessage
  }
  if (provider === 'FreighterMobile') {
    const signed = await requestMobileWallet<{ signature: string; signerAddress?: string }>(address, networkPassphrase, { method: 'stellar_signMessage', params: { message } })
    if (!signed.signature || (signed.signerAddress && signed.signerAddress !== address)) throw new Error('Varial did not sign the expected sign-in challenge')
    return signed.signature
  }
  const result = await freighterApi.signMessage(message, { address, networkPassphrase })
  if (result.error) throw new Error(result.error.message || 'The wallet rejected the sign-in request')
  if (!result.signedMessage || result.signerAddress !== address) throw new Error('The wallet did not sign the expected sign-in challenge')
  return typeof result.signedMessage === 'string' ? result.signedMessage : Buffer.from(result.signedMessage).toString('base64')
}

export function shortenStellarAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 5)}...${address.slice(-5)}` : address
}

export function stellarExplorerAccount(address: string) {
  return `${STELLAR_EXPLORER_URL}/account/${address}`
}
