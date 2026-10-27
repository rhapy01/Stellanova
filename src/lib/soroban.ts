import { Client } from '@stellar/stellar-sdk/contract'
import { Server } from '@stellar/stellar-sdk/rpc'
import { signStellarTransaction, SOROBAN_RPC_URL, type StellarWallet } from './stellar'

export const sorobanServer = new Server(SOROBAN_RPC_URL)

export type SorobanMarketplaceConfig = {
  nftContractId?: string
  marketplaceContractId?: string
  paymentToken?: string
}

export type StellarPaymentAsset = { code: string; contractId: string; decimals: number }
export const stellarPaymentAssets: StellarPaymentAsset[] = [
  { code: 'XLM', contractId: import.meta.env.VITE_STELLAR_PAYMENT_TOKEN ?? 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', decimals: 7 },
  ...(import.meta.env.VITE_STELLAR_PAYMENT_TOKENS ?? '').split(',').map((entry: string) => {
    const [code, contractId, rawDecimals] = entry.trim().split(':')
    const decimals = rawDecimals === undefined ? 7 : Number(rawDecimals)
    return code && contractId && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? { code: code.toUpperCase(), contractId, decimals } : null
  }).filter((asset: StellarPaymentAsset | null): asset is StellarPaymentAsset => Boolean(asset)),
].filter((asset, index, assets) => assets.findIndex((candidate) => candidate.contractId === asset.contractId) === index)

export const sorobanMarketplaceConfig: SorobanMarketplaceConfig = {
  nftContractId: import.meta.env.VITE_STELLAR_NFT_CONTRACT_ID ?? 'CDEESFFVHROBZDWVK7CCKTUFGGATKIZOIOS4BHA7V6ENRF3W25C6FBOR',
  marketplaceContractId: import.meta.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? 'CDQJZ6TKAAUIZW7AMH7XKECRHNVDU4REGMWU7RLJGM5AHIQYZS7GC6TL',
  paymentToken: import.meta.env.VITE_STELLAR_PAYMENT_TOKEN ?? 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
}

/**
 * Creates a generated Soroban Client once the deployed contract ID is configured.
 * Contract calls still require the deployed ABI/client methods and must be simulated
 * before a wallet signs them. No secret key ever enters this browser module.
 */
export async function createSorobanClient(contractId: string, wallet: StellarWallet) {
  return Client.from({
    contractId,
    networkPassphrase: wallet.networkPassphrase,
    rpcUrl: SOROBAN_RPC_URL,
    publicKey: wallet.address,
    signTransaction: async (transactionXdr: string) => ({
      signedTxXdr: await signStellarTransaction(transactionXdr, wallet.address, wallet.networkPassphrase, wallet.provider),
      signerAddress: wallet.address,
    }),
  })
}
