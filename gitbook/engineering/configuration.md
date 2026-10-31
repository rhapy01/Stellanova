# Configuration and environment

`.env.example` is the source of truth for environment variable names. This page describes variable groups, not secret values. Keep private values in local ignored environment files or protected deployment settings.

## Client-visible configuration

Variables prefixed with `VITE_` are included in browser code. Only use them for public configuration:

- Stellar network, Soroban RPC, contract IDs, and payment-token IDs.
- Privy application ID.
- PostHog public project key and host.
- Public media delivery URLs/names.

Never put deployer secrets, API secrets, database credentials, or signing keys in `VITE_` variables.

## Server-only configuration groups

- Database connection, including `DATABASE_URL`.
- Privy server verification credentials.
- Cloudinary/R2 storage credentials and media upload authorization.
- SMTP/email credentials and sender settings.
- Cron secret, operations email/webhook and indexer thresholds.
- Stellar deployer and marketplace keeper signing secrets.
- Cloudflare Workers AI credentials.
- Browser push VAPID keypair and subject when configured.

Consult `.env.example` for the exact current variable names and defaults. Never copy actual secret values into this GitBook.

## Network selection

Checked-in defaults target Stellar Testnet. Verify network, RPC, payment token, and contract IDs together. Changing the frontend network variable alone does not deploy contracts or migrate existing NFT state.
