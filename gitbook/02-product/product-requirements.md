# NovaMarket: Product Requirements

**Status:** Current product map · **Network:** Stellar Testnet

This page describes the intended behavior of the product as it exists today. “Implemented” means code paths are present; it does not imply every deployment is correctly configured or every journey has automated end-to-end coverage.

## Product principles

1. **One social product:** feed, creator identity, discovery, studios, collections, and commerce should connect through recognizable creator and artwork pages.
2. **Social art first:** a post is a useful destination in its own right. NFT minting is an option in the creative journey, not a prerequisite for sharing art.
3. **Creator control:** creators choose what to publish and how much to mint; the platform should not fabricate supply limits or metadata.
4. **Clear asset boundaries:** distinguish social posts, individual NFTs, collections, services, physical artwork, and exhibitions in the UI and data model.
5. **Trustworthy activity:** distinguish off-chain social counts from Stellar-confirmed mints, transfers, sales, and payments.
6. **Stellar-first execution for this release:** Stellar Testnet and XLM are the current chain and payment context; do not suggest local-currency checkout or Mainnet availability.

## User groups and needs

| User group | Need | Relevant product surface |
| --- | --- | --- |
| Independent artist | Make or upload work, publish consistently, and build an audience | AI Art, Pixel, Painter & Mural studios; feed; profile |
| Collection creator | Organize artwork, configure supply/drop rules, mint, and share the collection | AI Collection or standard collection creation; collection page; mint setup |
| Collector | Discover art and creators, understand ownership/listing status, and collect | Feed, Explore, public profiles, collection pages, marketplace |
| Service provider | Describe a creative service and receive a request | Dedicated services page and creator service listings |
| Physical artist | Present original physical work and receive an order request/payment | Dedicated physical-art page and order workflow |
| Exhibition organizer | Publish a real-world exhibition with place and schedule details | Dedicated exhibitions page |

These user groups are design targets, not measured demographic segments.

## Core journeys and acceptance criteria

### 1. Share an individual artwork

1. A signed-in creator makes work in a studio or uploads an image.
2. The creator can publish the artwork to the social feed without having to mint it as an NFT.
3. A feed viewer can open the artwork/creator page, interact socially, follow the creator, and tip an eligible individual-art post in XLM.
4. A collection post is not tip-enabled. Tipping is available only in the feed.

**Acceptance:** the post appears once, links to the correct creator/artwork, and does not create a duplicate merely because the NFT was already auto-posted after minting. Tip status and amount are reported separately from likes and marketplace volume.

### 2. Create a collection and mint

1. The creator starts a standard or AI-assisted collection workflow.
2. They provide collection information and artwork, review generated or uploaded work, and save the collection.
3. They configure mint stages, price, schedule, allowlists, per-wallet rules, and creator-selected supply as applicable.
4. The collection page exposes the next relevant action, such as mint setup, reveal, or minting, based on actual state.
5. On-chain confirmation precedes verified mint status; the indexer later updates searchable application views.

**Acceptance:** a collection that already contains generated artwork is not incorrectly treated as an empty collection requiring a first NFT. Do not enforce an undocumented platform supply ceiling. A stale indexer view must be distinguishable from a failed transaction.

### 3. Discover and collect

1. A collector can browse feed and Explore, filter/sort marketplace content, and open creator, collection, or NFT detail pages.
2. An NFT owner can see ownership and listing status with consistent cards and clear actions.
3. Buyers see the offered asset, payment asset, price, expiry/auction state, and wallet confirmation before signing.
4. The UI reports submitted, confirmed, failed, and indexed states distinctly where those states are available.

**Acceptance:** marketplace volume counts confirmed marketplace sales according to its documented definition. Mints, offers, social reactions, and non-sale transfers are not silently added to traded volume.

### 4. Publish creator services, physical art, or an exhibition

1. Each activity has its own dedicated page and listing form.
2. Service listings describe creative work available for hire; requests are not represented as completed bookings until accepted/fulfilled.
3. Physical-art listings describe a physical object; order, XLM payment, delivery, and status are displayed separately.
4. Exhibitions describe an event with location and schedule; publishing an event does not verify that it took place.

**Acceptance:** these categories remain separate from NFT collections and from each other. No local currency is shown for this release.

## Feature status map

| Feature | Status | Important boundary |
| --- | --- | --- |
| Feed, profiles, follows, reactions, comments | Implemented in repository | Social data is off-chain; not proof of human adoption. |
| Stories | Implemented in repository | Visibility rules apply to followed creators/collections and holders; story media is time-limited at the product layer. |
| Standalone AI Art, AI Collection, Pixel, Painter & Mural | Implemented in repository | AI output depends on provider availability, model terms, and configured credentials. |
| Collection creation, mint setup, reveal | Implemented in repository | Creator-configured supply; contract and indexer state must be reconciled. |
| NFT listings, auctions, individual/collection/trait offers | Implemented for supported flows | Exact supported operations vary with deployed contract and app configuration. |
| Individual artwork tips | Implemented in feed flow | Feed-only; collection posts cannot be tipped. |
| Creator services, physical art, exhibitions | Initial workflows implemented | Operational terms, fulfilment, refunds/disputes, and demand are not fully established by code. |
| PWA and Telegram entry | Present in repository | PWA/browser support and Telegram Mini App operation require device/provider checks; web product remains usable outside Telegram. |

## Non-goals for the current release

- Mainnet launch or migration is not part of the current Testnet product state.
- Local-currency checkout is not in scope; Stellar-side commerce is denominated in XLM for now.
- The platform does not adjudicate copyright or prove that an off-platform person created an uploaded work.
- No promise of automatic fulfilment, real-world delivery, dispute resolution, or ticket validation is made unless separately implemented and documented.
- No “all marketplace functionality” claim should be used without an explicitly maintained support matrix.

## Product metrics to define

Before using metrics externally, record a definition, source, time window, and verification method for each:

- Creator activation: first successfully published artwork or collection.
- Social-to-collecting conversion: feed/creator/collection discovery followed by a ledger-confirmed mint or marketplace purchase.
- Repeat creator and collector activity: distinct active periods, excluding test wallets identified by the founder's stated rules.
- Confirmed marketplace volume: settled secondary trades only, denominated and converted with a documented rule.
- Collection completion: creator-configured supply versus confirmed mints, with stage-level breakdown.
- Service requests and physical-art orders: requests, accepted orders, XLM payments, and fulfilment states reported separately.

Do not present client-generated analytics events as verified transactions or as proof that a person is independent from the project team.
