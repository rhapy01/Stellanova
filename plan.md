# NFTGram implementation overview

NFTGram is a Testnet NFT marketplace and social feed built with Vite, React, TypeScript, Express, Postgres, Privy, and Stellar Soroban. Marketplace cards, collections, posts, and ownership views must come from indexed Testnet or persisted user data. The browser bundle has empty fallback arrays; a separate opt-in Testnet feed seed fixture exists for visual testing and is not production marketplace data.

## Current architecture

- `src/App.tsx` contains the main experience and Testnet wallet and marketplace flows.
- `src/lib/stellar.ts` contains Stellar wallet and Soroban transaction helpers.
- `src/lib/backend.ts` calls the authenticated API and indexed read models.
- `server/index.ts` contains the API, authentication, uploads, and read-model routes.
- `server/db.ts` defines Postgres schema and compatibility migrations.
- `src/data.ts` defines shared content types and empty-state fallbacks; indexed records are loaded from the API. `scripts/seed-testnet-feed.ts` and `.testnet-sample-content.json` are an explicit Testnet-only visual fixture.
- `contracts/` contains the Soroban NFT and marketplace contracts.
- `public/` contains PWA assets and contract artifacts.

## Product constraints

- Stellar Testnet is the active network. Mainnet remains a separate release gate.
- Email signup and embedded Stellar wallets use Privy; Freighter remains an external-wallet option.
- Empty marketplace, collection, and social views must say there is no content yet. Do not substitute sample records or stock artwork.
- NFT metadata must use a configured, reachable HTTPS metadata host. Do not mint with a fabricated metadata URL.
- Chain actions must use verified indexed ownership and mapped token/listing records.

## Remaining delivery work

See [TODO.md](TODO.md) for Testnet feature completion and [SCALE_PLAN.md](SCALE_PLAN.md) for reliability, delivery speed, and traffic growth work. The product owner confirms the core wallet, media, mint/indexing, social, marketplace, and notification journeys work in the running Testnet app. The repository has unit tests for all three Soroban contracts but no automated Express/PostgreSQL end-to-end suite, so those flows are not automatically replayed by CI.
