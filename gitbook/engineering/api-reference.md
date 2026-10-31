# HTTP API reference

The authoritative request validation, response shapes, authentication middleware, and side effects are in `server/index.ts`. This is an index of route groups, not a generated OpenAPI contract; inspect handlers before integrating.

`requireWallet` marks authenticated wallet routes. Admin routes use `requireAdmin`; cron routes require cron authorization. Public `GET` routes may still depend on a healthy database or Stellar RPC.

| Group | Representative routes | Purpose |
| --- | --- | --- |
| Health and public metadata | `GET /api/health/live`, `/api/health/ready`, `/robots.txt`, `/sitemap.xml` | Platform probes and crawler metadata |
| Authentication | `POST /api/auth/privy/session`, `/api/auth/challenge`, `/api/auth/verify`, `/api/auth/logout` | Privy verification and wallet session/challenge flows |
| Feed/social | `GET/POST /api/posts`, `/api/posts/:id/like`, `/comment`, `/repost`, `/tips`; `/api/creators/*` | Posts, interactions, creator profiles/follows |
| Collections | `/api/collections`, `/api/collections/:slug/*`, `/api/collections/:id/like`, `/comment`, `/stories` | Collection data, drop setup, reveal, mint history and social activity |
| NFTs | `/api/nfts/mint`, `/api/nfts/minted`, `/api/nfts/:contract/:tokenId/activity`, `/provenance` | Mint registration, indexed tokens, activity and provenance |
| Marketplace | `/api/marketplace/status`, `/state/:wallet`, `/offers/:offerId/*`, `/ownership/:wallet` | Marketplace reads and counter-offer metadata |
| Creator commerce | `/api/creator-services/*`, `/api/physical-art/*`, `/api/exhibitions` | Services/requests, physical art/orders, exhibitions |
| Media and AI | `/api/media/*`, `/api/ai/*`, `/api/creator/metadata` | Upload, media, generation and image analysis |
| Notifications | `/api/notifications*`, `/api/push/*` | In-app notifications and browser push |
| Admin/operations | `/api/admin/ops/*`, `/api/indexer/status`, `/api/cron/*` | Restricted diagnostics, reconciliation and scheduled operations |

## Integration notes

- Exact required fields, limits, response codes, and state changes are defined in route handlers.
- Client-generated analytics events are not verified chain activity or proof of human adoption.
- A successful response that submits a chain operation may precede ledger confirmation and indexer updates.
- Avoid putting admin response details or private user data in public GitBook pages.
