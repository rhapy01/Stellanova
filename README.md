# StellaNova

StellaNova is a social-first NFT marketplace and creator platform built on Stellar and Soroban. It combines a social feed and collection discovery with tools for creating, minting, and managing digital collectibles.

> **Network status:** The current application and deployed contracts target Stellar Testnet. Treat it as a development product; do not use it to custody or transact with real-value assets.

## What is in this repository

- `src/` — React and TypeScript application, feed, marketplace views, and creator studios.
- `server/` and `api/` — Express API, data access, transaction indexing, media and email handling.
- `contracts/` — Soroban NFT, marketplace, and account contracts with Rust unit tests.
- `public/contracts/` — compiled contract artifacts used by the application.
- `vercel.json` — Vercel build, routing, and scheduled operations-monitor configuration.

## Local development

Requirements: Node.js 22 or newer, npm, and a PostgreSQL-compatible database for server-backed features. Rust stable is required to run the Soroban contract tests.

```sh
npm ci
cp .env.example .env
npm run dev
```

Set the required local environment values in `.env`. The checked-in `.env.example` contains public Testnet settings and blank credential fields. Keep real secrets in the local ignored `.env` file or a deployment secret store. Never put server credentials in `VITE_` variables; Vite exposes those values to browser code.

The app is configured for Testnet by default. Configure the database, Privy, storage, email, and monitoring services as needed for the features you are working on. Server-only configuration names and comments are listed in `.env.example`.

## Build and checks

```sh
npx tsc --noEmit
npm run build
```

Run Soroban contract unit tests with:

```sh
cargo test --locked --manifest-path contracts/account/Cargo.toml
cargo test --locked --manifest-path contracts/nft/Cargo.toml
cargo test --locked --manifest-path contracts/marketplace/Cargo.toml
```

GitHub Actions runs the TypeScript check and frontend build, plus all three contract test suites, for pushes to `main` and pull requests.

## Deployment

The repository includes Vercel configuration. To enable continuous deployment, connect this GitHub repository to the StellaNova Vercel project and configure deployment environment variables from `.env.example` in Vercel’s protected settings. Vercel Git integration can then build and deploy pushes according to the project’s branch settings. Do not commit `.env`, `.env.local`, deployment credentials, or `.vercel/` state.

Testnet contract build and deployment scripts are available as npm scripts. They require the Stellar CLI and a Testnet deployer secret. Review the scripts and target network before running them.

## Security

Please do not report vulnerabilities in public issues. Contact the maintainers privately before disclosing a security issue. Never submit real wallet secrets, API tokens, or production credentials.

## License

MIT. See [LICENSE](LICENSE).
