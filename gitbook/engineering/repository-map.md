# Repository map

| Path | Responsibility |
| --- | --- |
| `src/` | React/TypeScript client, routes, UI, creator studios, wallet and media integrations |
| `server/index.ts` | Express API routes and server initialization |
| `server/db.ts` | PostgreSQL connection, query helpers, schema initialization/migrations |
| `server/indexer.ts` | Soroban event indexing and marketplace/NFT read-model updates |
| `server/push.ts`, `server/mail.ts` | Browser push and email delivery |
| `api/index.ts` | Vercel serverless entry point |
| `contracts/account/` | Soroban account contract source and tests |
| `contracts/nft/` | Soroban NFT/collection contract source and tests |
| `contracts/marketplace/` | Soroban marketplace source and tests |
| `public/contracts/` | Compiled contract artifacts used by application/deployment workflows |
| `scripts/` | Testnet deployment, maintenance, and audit scripts |
| `vercel.json` | Vercel build, routes, headers, functions, and cron configuration |
| `.github/workflows/` | GitHub Actions workflows |

The frontend is built by Vite. Production API requests are routed through the Vercel function configured in `vercel.json`.
