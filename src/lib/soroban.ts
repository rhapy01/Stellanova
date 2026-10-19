import { Client } from '@stellar/stellar-sdk/contract'
import { Server } from '@stellar/stellar-sdk/rpc'
import { signStellarTransaction, SOROBAN_RPC_URL, type StellarWallet } from './stellar'

export const sorobanServer = new Server(SOROBAN_RPC_URL)

export type SorobanMarketplaceConfig = {
  nftContractId?: string
  marketplaceContractId?: string
  paymentToken?: string
}

export const sorobanMarketplaceConfig: SorobanMarketplaceConfig = {
  nftContractId: import.meta.env.VITE_STELLAR_NFT_CONTRACT_ID ?? 'CDEESFFVHROBZDWVK7CCKTUFGGATKIZOIOS4BHA7V6ENRF3W25C6FBOR',
  marketplaceContractId: import.meta.env.VITE_STELLAR_MARKETPLACE_CONTRACT_ID ?? 'CBITVCCK4VLVRIUJ35YD6VTR7IAYWZJG3NBEQ6NTO2367YTMHSGQY3Y6',
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
