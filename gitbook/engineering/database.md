# Database schema

PostgreSQL schema setup and migration logic live in `server/db.ts` and `server/migrate.ts`. This is a domain map; consult SQL definitions for exact columns, constraints, indexes, and migration behavior.

| Domain | Representative tables |
| --- | --- |
| Identity and sessions | `wallet_accounts`, `wallet_auth_challenges`, `wallet_sessions`, `user_profiles` |
| Social/feed | `posts`, `post_likes`, `post_dislikes`, `post_comments`, `post_reposts`, `creator_follows`, `nft_likes`, `nft_comments`, `nft_bookmarks` |
| Stories and notifications | `creator_stories`, `collection_stories`, `story_views`, `notifications`, `browser_push_subscriptions` |
| Collections and minting | `collections`, `collection_nft_contracts`, `nft_contract_registry`, `nft_mints`, `mint_stages`, `mint_whitelist`, `collection_drop_drafts`, `creator_nft_metadata`, `creator_media_uploads` |
| Chain read models | `nft_ownership`, `verified_nft_mints`, `stage_mint_events`, `marketplace_events`, `indexer_state`, `canonical_metadata`, `token_collections` |
| Marketplace | `marketplace_listings`, `marketplace_auctions`, `marketplace_offers`, `marketplace_collection_offers`, `marketplace_trait_offers`, `marketplace_offer_responses` |
| Creator commerce | `creator_service_listings`, `creator_service_requests`, `creator_exhibitions`, `physical_art_listings`, `physical_art_orders`, `creator_commerce_payments` |
| Operations and referrals | `ops_alert_state`, `ops_reconciliation_runs`, `referral_codes`, `referrals`, `public_feedback` |

## Data authority

PostgreSQL stores social/product records and indexes chain events. Chain-derived rows are projections, not the source of truth for current token ownership. For mismatches, reconcile against Stellar and contract state before changing indexed rows.

## Schema changes

Use the project migration path and preserve idempotence where required by startup behavior. Do not manually alter production data without retaining transaction/event evidence and a review trail.
