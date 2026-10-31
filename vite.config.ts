import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const metaMaskAdapterPath = fileURLToPath(new URL('./node_modules/@metamask/connect-stellar/dist/adapter.mjs', import.meta.url))

export default defineConfig({
  plugins: [react()],
  // The package root also exports its Stellar Wallets Kit module, which pulls
  // in the entire multi-wallet kit as an undeclared runtime dependency. NovaMarket
  // uses the standalone SEP-0043 adapter, so resolve it directly.
  resolve: { alias: { '@metamask/connect-stellar': metaMaskAdapterPath } },
})
