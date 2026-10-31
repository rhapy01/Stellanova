# Development setup

## Requirements

- Node.js 22 or newer and npm.
- PostgreSQL-compatible database for API-backed behavior.
- Rust stable for Soroban contract tests.
- Stellar CLI for contract build/deployment commands.

## Install and run

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

Set local integration values in `.env`. Do not commit it. The example defaults to Stellar Testnet. Database-backed routes need a reachable PostgreSQL database; optional features need their respective service configuration.

## Build and type checks

```sh
npx tsc --noEmit
npm run check:server
npm run build
```

## Contract tests

```sh
cargo test --locked --manifest-path contracts/account/Cargo.toml
cargo test --locked --manifest-path contracts/nft/Cargo.toml
cargo test --locked --manifest-path contracts/marketplace/Cargo.toml
```

## Relevant npm scripts

| Script | Purpose |
| --- | --- |
| `dev` | Start the Express application with `tsx` |
| `build` | Build the Vite frontend into `dist/` |
| `check:server` | Type-check server/API source |
| `db:migrate` | Run the database migration entry point |
| `build:nft-contract` | Build NFT contract and copy its artifact |
| `build:marketplace-contract` | Build marketplace contract and copy its artifact |
| `deploy:testnet` | Deploy configured Testnet contracts |
| `deploy:marketplace:testnet` | Deploy marketplace contract to Testnet |
| `redeploy:nft:testnet` | Run the NFT Testnet deployment script |

Read each deployment script before use; deployment changes Testnet state and requires a funded signer.
