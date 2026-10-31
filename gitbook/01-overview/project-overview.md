# NovaMarket: Project Overview

**Status:** Public project overview · **Network:** Stellar Testnet

## What NovaMarket is

NovaMarket is a social art marketplace and creator platform built on Stellar. It brings together a social feed, public creator and collection pages, creative studios, NFT collections and minting, and marketplace activity. A creator can make or upload work, publish individual artwork into the feed, or turn work into a collection that collectors can mint and trade. A collector can discover work socially, follow its creator, and move from a post or collection into collecting.

The platform also has separate experiences for creator services, physical artwork, and real-world exhibitions. These are different creator activities, not NFT subtypes.

## The problem NovaMarket is addressing

**Assumption to validate:** artists and collectors often move between separate tools to make art, publish it, build an audience, organize a drop, and sell or collect the resulting work. That separation can create friction and disconnect social attention from collecting.

NovaMarket is designed to connect those steps in one social product. The problem statement is a product hypothesis; the repository alone does not prove its prevalence or willingness to pay. User research, observed completion rates, repeat behavior, and comparison with existing alternatives are needed to validate it.

## Who it is for

- Digital artists, including AI-assisted, pixel, and painter/mural creators.
- Creators who want a collection, mint, or drop workflow connected to social publishing.
- Collectors who discover creators and artwork through a feed and public profiles.
- Creative professionals who offer services through a listing and request flow.
- Artists selling physical artwork and organizers publishing exhibitions.



## Product value proposition

NovaMarket's intended value is the connected journey: create or share art, build a public creator identity, reach people through social discovery, and offer collecting or commerce in the same product. On-chain minting and marketplace transactions use Stellar; social content, profiles, and application workflow data use the off-chain application and database.

NovaMarket's focus is the connected social art journey. The [Investor Plan](https://stelanova.gitbook.io/stelanova-docs/executive-and-investor/investor-plan) compares this direction with existing products.

## Current product surface

| Capability | Current implementation status |
| --- | --- |
| Social feed and public profiles | Implemented in the repository; API and UI support posts, creator pages, following, and social interactions. |
| Stories and notifications | Implemented in the repository, including creator/collection stories and notification/push paths; delivery depends on deployment and browser support. |
| Creative studios | Four workflows are present: AI Art, AI Collection, Pixel, and Painter & Mural. AI generation depends on configured providers and model terms. |
| Collections and minting | Stellar Testnet collection, mint-stage, allowlist, reveal, and mint-history paths are present. Ledger confirmation and indexer projection are separate steps. |
| NFT marketplace | Supported listing, auction, offer, and settlement flows exist in the application and Soroban code. This is not a claim that every market feature is complete. |
| Artwork tips | Individual artwork posts can receive tips in the feed. Collection posts are not tip targets, and tips are not offered outside the feed. |
| Creator services | Separate service discovery/listing and request workflows exist. This is not represented as a complete appointment or escrow system. |
| Physical artwork | Separate listing and order workflows exist, with XLM payment paths. Physical delivery and dispute handling remain operational responsibilities and risks. |
| Exhibitions | A distinct exhibition discovery and publishing workflow exists for real-world exhibitions. Ticketing and attendance verification are not claimed. |

## Stage and evidence

- **Verified from the repository:** the project contains a React/TypeScript client, Express API, PostgreSQL-backed application, Stellar SDK integrations, Soroban account/NFT/marketplace contracts, and a chain-event indexer.
- **Founder-reported:** the product is being exercised on Stellar Testnet and real functional issues are addressed as they arise.
- **Not established here:** independently audited contracts, Mainnet readiness, revenue, validated total addressable market, user retention, or a comprehensive automated end-to-end test suite.

The app's visible analytics and user-submitted social events must not be treated as independent adoption evidence. Chain-derived activity should be reconciled against Stellar ledger records before use in an external claim.

## Product boundaries

- Stellar Testnet is the current network context; this overview does not direct users to transact with real-value assets.
- The current commerce scope is XLM; local currency support is not part of this version.
- NovaMarket provenance covers the platform's own recorded workflow and indexed chain events. An NFT minted on NovaMarket does not establish the truth of off-platform authorship claims.
- The creator chooses collection supply and mint policy. Do not describe a fixed platform-wide supply limit.
- Social interaction counts and on-chain trading/minting metrics are separate measures.

## What must be proven next

1. Creators can complete the path from making work to publishing, collection setup, and a successful Testnet mint without losing context.
2. Social discovery leads to meaningful creator follows, collection visits, tips, and on-chain collecting.
3. Stellar-specific functionality provides a measurable reason to use Stellar in NovaMarket.
4. The product's integrated social workflow is meaningfully useful compared with existing Stellar NFT marketplaces and generic social platforms.
5. The business model and operational costs can support sustainable creator activity.
