# NFTGram delivery outcomes

- [x] **Mobile-first visual discovery feed:** NFTGram presents an image-led mobile-first visual discovery feed with a familiar feed rhythm and NFT cards, creator attribution, pricing, marketplace actions and a premium Instagram-inspired visual language.
- [x] **NFT discovery and entry points:** Users can browse, search, filter and enter NFT detail, creator and collection views from the discovery experience.
- [x] **NFT detail experience:** Each NFT detail view presents artwork media, ownership and creator context, collection information, pricing and key metadata.
- [x] **Creator profiles:** Creator profile views present identity, biography, market metrics and available or collected artwork.
- [x] **Collection pages:** Collection views present collection branding, summary statistics and a browsable item grid.
- [x] **Saved items:** Users can favorite NFT items and revisit selected NFTs in a dedicated saved view.
- [x] **Wallet-ready purchase states:** Marketplace actions provide clear connect-wallet, availability, price and Testnet transaction states without pretending a transaction has completed.
- [x] **Responsive premium UI:** The interface works across mobile, tablet and desktop while retaining an everyday visual-shopping feel.
- [x] **Installable PWA:** NFTGram includes a web app manifest, app icons, standalone display mode, service-worker shell caching and resilient loading/offline states.
- [x] **Marketplace pulse:** The home feed exposes 24-hour volume, lowest floor, active listings and creator royalty signals so collectors can orient before browsing.
- [x] **Listing-type discovery:** Explore supports All listings, Buy now, Auctions and Offers tabs, plus price sorting and existing discovery filters.
- [x] **Marketplace metadata:** NFT records and detail pages expose sale type, chain, best offer, auction timing and creator royalty context.
- [x] **Offer intent flow:** NFT detail pages submit Soroban Testnet offer transactions for indexed listing records and do not expose actions for unmapped artwork.
- [x] **Instagram color system:** The interface uses Instagram-inspired white, black, purple–pink–red–orange gradient and #EFEFEF light grey as its primary visual system.

- [x] **Stellar wallet foundation:** NFTGram uses the official Stellar JavaScript SDK and Freighter API for non-custodial Stellar wallet connection, network detection, address state and safe transaction-signing helpers.
- [x] **Stellar-native Testnet labels:** Chain, owner and price labels use Stellar, SEP-50 NFT and XLM vocabulary.
- [x] **Soroban marketplace settlement (Testnet core):** NFTGram includes compiled and deployed SEP-50 NFT and marketplace contracts, Soroban invocation/simulation/signing/submission helpers, a verified minted token, and a verified active 1 XLM Testnet listing. Listing and offer lifecycles are available; auction UI/read-model integration and creator-specific royalty configuration are still incomplete.
- [x] **Create & mint NFTs:** The Account view now has a Mint NFT flow that invokes the SEP-50 contract `mint` (real Soroban transaction) and records the token in a new `nft_mints` read model, mapping it into a collection and refreshing the Owned feed. Newly minted tokens surface in the Owned feed and can be re-listed for resale.
- [x] **Collection mint timeline (drop schedule + allowlists):** Grounded in OpenSea/SeaDrop, collections now support an ordered set of mint stages — up to 5 presale (team / guaranteed / FCFS) plus a mandatory final public stage — each with its own start/end window, price and per-wallet limit. Creators add stages and whitelist wallets per stage (with optional per-wallet custom limit/price, CSV-style). Collectors see a mint timeline on the collection page showing each stage's window, price, limit and their eligibility (whitelisted · team / guaranteed / FCFS / not-whitelisted / public), with a live-now indicator and a Mint affordance. Backed by `mint_stages` / `mint_whitelist` tables and `/api/collections/:slug/drop*` endpoints.
- [x] **Secondary-trading management:** A new per-wallet `GET /api/marketplace/state/:wallet` endpoint plus an Account “Marketplace” panel lets a wallet cancel its live listings, cancel/refund its pending offers, and accept incoming offers on tokens it owns — each a real `cancel_listing` / `cancel_offer` / `accept_offer` Soroban invocation.
- [x] **Indexed read model (mint + listing/offer state):** The indexer tracks ownership from SEP-50 `mint`/`transfer` events (parsing `to` = owner and `data[0]` = token id), and the backend exposes `GET /api/nfts/minted` and `GET /api/marketplace/state/:wallet` read-model endpoints. Collections, verification, social and notification persistence remain as described.
- [x] **Dual marketplace feeds:** The home feed now supports All NFTs and Owned by me modes; ownership is wallet-gated and only indexed/on-chain owner records should populate the owned feed.
- [x] **Collection subscriptions and drop alerts:** Users can follow collections from the feed or Collections view; followed collection drops are promoted in the feed and persisted notifications are generated from indexed mint events. Local storage remains an offline fallback.
- [x] **Freighter wallet authentication:** API identity is established with a single-use, five-minute challenge signed by the connected Stellar wallet; authenticated API requests use a short-lived server session. The backend no longer trusts a caller-supplied wallet-address header.
- [x] **Email signup and embedded Stellar wallet:** Privy email OTP signs users in, creates/loads their Stellar G-address wallet, verifies the address against the Privy-authenticated user on the server, and signs Stellar transaction hashes without exposing keys to NFTGram. Configure `VITE_PRIVY_APP_ID`, `PRIVY_APP_ID`, and `PRIVY_APP_SECRET` to enable it; Freighter remains available as an optional existing-wallet path.
- [ ] **Testnet Privy onboarding verification:** Frontend and server credentials are configured and the Privy API accepts them. Verify the full email signup, wallet creation, reload, Testnet sign and logout flow with a real user email.
- [x] **Feed engagement:** NFT cards and detail pages support persistent likes and comments in the local client state, with collection drill-down from every feed card.
- [x] **Ownership-gated selling:** Feed and detail Sell actions refuse wallets that do not own the NFT, while owned items open the Soroban approval → list flow with a price and expiry.
- [ ] **Notification delivery:** The authenticated server inbox and indexed Testnet event notifications are implemented. Optional email/push delivery and delivery preferences are not implemented.
- [ ] **Marketplace completeness on Testnet:** Finish auction create/bid/cancel/settle UI and indexed auction state; connect marketplace payout configuration to creator-level royalties instead of the current global contract setting; reconcile every lifecycle event in the read model.
- [ ] **Canonical token metadata:** Remove any preloaded/sample metadata and complete creator upload → immutable metadata → mint → indexed display using a configured HTTPS metadata host.
- [ ] **Testnet creator media workflow:** Server-side R2/Cloudinary upload and canonical R2 metadata endpoints exist, but provider credentials are environment-dependent and minted token metadata is not yet reliably created from the creator mint flow. Complete upload → metadata → mint → read-model display end to end on Testnet.
- [ ] **Scale readiness:** Define measurable SLOs, production environment separation, error tracking, backups/restore, rate limits, and load checks before public launch. See [SCALE_PLAN.md](SCALE_PLAN.md).

## Deferred until Mainnet

- Sponsored account activation and transaction fees, production custody disclosures, Mainnet contract deployment/audit, production domain and provider credentials. These are not Testnet feature blockers.
