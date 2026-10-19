import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = process.cwd()
const source = resolve(root, 'contracts/nft/target/wasm32v1-none/release/nftgram_nft.wasm')
const destination = resolve(root, 'public/contracts/nftgram_nft.wasm')

mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
console.log(`Updated ${destination}`)
