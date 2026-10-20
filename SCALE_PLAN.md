# NFTGram scale and delivery plan

This plan assumes Stellar Testnet remains the active network until the product's core flows are complete. Scale work should follow measured bottlenecks; do not add infrastructure just because a component is fashionable.

## Core Testnet journeys

The product owner confirms the current user journeys work: Privy email signup and wallet restore, media upload and metadata creation, minting and indexed ownership, social persistence, listings/offers/auctions, collection mint stages, and in-app notifications. The open integration-test item below is about automated regression coverage; it does not imply these journeys are currently broken.

Separate product limitations remain: the marketplace contract uses a configured royalty recipient/rate rather than automatic per-creator royalty routing, and optional email/push notification preferences are not implemented.

## Scale in stages

### Reliability before traffic

- Implemented in the app: API request IDs and structured logs; liveness and database-readiness probes; DB-backed API 5xx and health alerts with webhook/email delivery and recovery notifications; daily authenticated Vercel Cron; admin transaction-reconciliation dashboard with bounded Soroban ownership and metadata repair. Set `CRON_SECRET` and SMTP or `OPS_ALERT_WEBHOOK_URL` in deployment environment to activate scheduled delivery. Soroban RPC and indexer readiness details remain admin-only.
- Implemented in contracts: a first 8-test Soroban NFT unit suite for collection reveal/minting, ownership boundaries, batch stage minting/caps and transfer state. Run with `cargo test --manifest-path contracts/nft/Cargo.toml`. This is a baseline; payment/allowlist, stage lifecycle, approval-expiry and marketplace integration cases are still needed before security review.
- Still needed: verify production alert delivery, run and retain a Testnet reconciliation drill, rehearse database backup restore, configure external log retention, add route-level exception traces and Privy availability metrics. Client-generated social funnel writes are disabled; social counts are not derived from those events.
- Track user-facing transaction states as pending, confirmed, failed or reconciliation-required. Store transaction hashes and make retries idempotent.
- Add database migrations with explicit versions and rollback notes; back up Postgres and rehearse a restore.
- Add rate limits and request/body/file-size limits to public and authenticated endpoints. Replace shared static media upload authorization with short-lived, scoped creator/admin authorization.

### Faster delivery

- CI now checks frontend and server/API TypeScript, builds the frontend, and runs all three Soroban contract unit suites. Still needed: an automated disposable-Testnet regression suite for email signup, wallet connect, mint, list, buy, offer, auction and media upload. This is test automation, not an unresolved user-facing flow. Keep deploys behind separate preview/Testnet/production configuration.
- Use a single API/data adapter for marketplace records and indexed chain records.
- Add contract ABI/config validation at startup and document repeatable Testnet deployment commands.

### Higher traffic

- Move the indexer from one in-process polling timer to a separately deployable worker with a durable cursor, bounded retries, dead-letter handling and an observable lag metric.
- Batch event projection writes and notification fan-out. Use a queue only when measured event volume or delivery latency requires it.
- Add cursor pagination to feeds, posts, comments and marketplace state; add composite indexes based on observed query plans.
- Cache public, read-only collection and marketplace responses at the edge with short TTLs; never cache wallet-private state or unconfirmed transaction state.
- Keep original media in R2 behind a custom domain and cache derivatives aggressively. Avoid serving originals for feed thumbnails.
- Load test API, database pool, indexer catch-up and media upload separately. Set budgets from measured p95 latency and expected peak concurrency.

## First scale metrics

- API p50/p95 latency and 5xx rate by route.
- Indexer lag in ledgers/time, retries, and unapplied event count.
- Transaction confirmation and reconciliation time by action.
- Database pool saturation, slow query count, and connection errors.
- Media upload success rate, bytes, provider latency and cache hit ratio.
- Signup completion and wallet-creation failure rate.

## Mainnet gate

Mainnet is a separate release gate, not part of current Testnet completion: contract security review, production deployment/configuration, sponsored activation and fee policy, backup/recovery drills, monitoring/on-call ownership, and custody/consumer disclosures must be approved before switching networks.
