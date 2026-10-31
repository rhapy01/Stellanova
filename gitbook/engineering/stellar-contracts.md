# Stellar and Soroban contracts

| Directory | Role |
| --- | --- |
| `contracts/account/` | Account registration contract |
| `contracts/nft/` | NFT collection, mint, ownership, reveal, and administration behavior |
| `contracts/marketplace/` | Listings, escrow, offers, auctions, settlement, fees/royalties, expiry/recovery |

Rust sources and tests are colocated in each project. Build scripts copy compiled WASM artifacts to `public/contracts/`. Network, RPC, and contract IDs are configured through `.env.example` variables.

## State authority

Contracts and Stellar determine on-chain ownership and marketplace escrow/settlement. The API/indexer provides searchable read models. Indexing is asynchronous; transaction and ledger state take precedence over a stale UI projection.

## Build and test

```sh
cargo test --locked --manifest-path contracts/account/Cargo.toml
cargo test --locked --manifest-path contracts/nft/Cargo.toml
cargo test --locked --manifest-path contracts/marketplace/Cargo.toml
npm run build:nft-contract
npm run build:marketplace-contract
```

Unit tests are regression coverage, not an independent audit. Verify the network and target contract before using a signer.

## Upgrade and compatibility

NFT and marketplace deployments have separate addresses and lifecycles. A new NFT contract does not migrate tokens or collection state from an older contract. Marketplace support for existing NFT contracts must remain explicitly configured if those tokens should continue trading. Inspect admin/upgrade methods and tests before changing WASM or key configuration.
