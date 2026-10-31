# System architecture

## Runtime components

1. **Web client:** React/TypeScript single-page application built with Vite. `src/App.tsx` owns top-level route parsing/navigation; product views and studios are composed from `src/` modules.
2. **HTTP API:** Express routes in `server/index.ts`, served locally by that entry point and through `api/index.ts` on Vercel.
3. **Relational state:** PostgreSQL accessed through `server/db.ts`; schema setup and migration logic live in server/database code.
4. **Chain:** Stellar SDK integrations submit/read Soroban operations. Soroban contracts own NFT and marketplace state.
5. **Indexer:** `server/indexer.ts` reads contract events and updates PostgreSQL read models and notifications.
6. **External services:** Privy, media storage, email, browser push, PostHog, and Cloudflare Workers AI are configured through environment variables.

## Trust and data boundaries

- Browser wallet signing authorizes user transactions; the server should not receive a user's signing secret.
- Authenticated API routes derive wallet identity from verified session state rather than trusting a client-supplied wallet field.
- Social interactions and creator-commerce records are application/database data.
- NFT ownership and marketplace escrow/settlement are determined by Stellar contract/ledger state. PostgreSQL is an indexed read model and can lag behind the ledger.
- Public media URLs and contract IDs are not credentials. Provider keys and service secrets are server-only.

## Routing

The client parses app routes in `src/App.tsx`. Vercel rewrites public share routes to API handlers that return social metadata, API paths to the Express handler, and remaining app routes to `index.html`. See `vercel.json` and route declarations in `server/index.ts`.
