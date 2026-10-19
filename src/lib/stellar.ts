import freighterApi from '@stellar/freighter-api'
import { Buffer } from 'buffer'
import { Networks } from '@stellar/stellar-sdk'

export type StellarNetwork = 'PUBLIC' | 'TESTNET' | 'FUTURENET' | 'STANDALONE'

export type WalletProviderName = 'Freighter' | 'Privy'

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

export async function connectFreighter(): Promise<StellarWallet> {
  const connection = await freighterApi.isConnected()
  if (connection.error) throw new Error(connection.error.message || 'Freighter could not be reached')
  if (!connection.isConnected) throw new Error('Install or unlock Freighter to connect a Stellar wallet')

  const [addressResult, networkResult] = await Promise.all([
    freighterApi.getAddress(),
    freighterApi.getNetworkDetails(),
  ])
  if (addressResult.error) throw new Error(addressResult.error.message || 'Freighter did not return an address')
  if (networkResult.error) throw new Error(networkResult.error.message || 'Freighter did not return a network')
  if (!addressResult.address) throw new Error('Freighter returned an empty Stellar address')
  if (networkResult.network !== STELLAR_NETWORK) {
    const expected = STELLAR_NETWORK === 'PUBLIC' ? 'Stellar Mainnet' : 'Stellar Testnet'
    throw new Error(`Switch Freighter to ${expected} before signing StellaNova transactions`)
  }

  return {
    address: addressResult.address,
    network: networkResult.network as StellarNetwork,
    networkPassphrase: networkResult.networkPassphrase,
    provider: 'Freighter',
  }
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
  const signed = await freighterApi.signTransaction(transactionXdr, { address, networkPassphrase: networkPassphrase as Networks })
  if (signed.error) throw new Error(signed.error.message || 'The Stellar wallet rejected the transaction')
  return signed.signedTxXdr
}

export async function signWalletChallenge(message: string, address: string, networkPassphrase: string) {
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
