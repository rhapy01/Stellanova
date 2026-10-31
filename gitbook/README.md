# NovaMarket: Master Project Dossier

**Document status:** Living project reference · **Product stage:** Testnet · **Last reviewed:** 2026-10-28

NovaMarket is a social art marketplace and creator platform built around Stellar. Artists can create and publish artwork, build collections, mint NFTs, and reach collectors through a shared social feed. Collectors can discover creators and collections, follow them, interact with posts, tip eligible individual artworks, and collect or trade NFTs. The product also has distinct starting points for exhibitions, creative services, and physical artwork.

NovaMarket brings creation, social discovery, and collecting into one creator experience.

## Project status at a glance

| Area | Current status | Evidence / limitation |
| --- | --- | --- |
| Social product | Implemented in the repository | Feed, creator profiles, follows, social interactions, stories, and notifications have client and API support. Runtime use is on Testnet. |
| Creative studios | Implemented in the repository | Standalone AI Art, AI Collection, Pixel, and Painter & Mural workflows are represented in the application. Provider configuration affects AI features. |
| NFT collections and minting | Implemented for Stellar Testnet | Soroban contracts, client transaction flows, API registration, and indexer read models exist. PostgreSQL indexing can lag the ledger. |
| Marketplace | Implemented for supported contract flows | Listings, auctions, offers, settlement, and collection/trait offer paths are represented. Current contract addresses and deployment state are environment-specific. |
| Creator economy | Initial product workflows implemented | Artwork tipping, service listings, physical-art listings/orders, and exhibitions have application/API support. Commercial demand and unit economics are not established in this dossier. |
| Mainnet readiness | Not claimed | This application and its configured contract deployment target Stellar Testnet. No Mainnet release is represented here. |
| Traction and revenue | Not asserted | This dossier does not convert early testing, client-submitted analytics, or Testnet activity into verified market traction or revenue. |

## How to read this dossier

The project documentation follows six connected areas from the requested documentation blueprint. The **master dossier** is the entry point; detailed engineering references remain separate so technical material can change without making the overview unreadable.

1. **Executive and investor:** project overview, investment thesis, market evidence, business model, and funding questions.
2. **Product:** users, capabilities, boundaries, journeys, requirements, and release criteria.
3. **Technical:** architecture, APIs, data, Stellar contracts, deployment, and development.
4. **Security, privacy, and risk:** controls, limitations, trust boundaries, threat scenarios, and response needs.
5. **Business, operations, and financial:** revenue hypotheses, operating model, metrics, and unvalidated financial assumptions.
6. **Governance and execution:** decisions, risks, milestones, evidence, and documentation ownership.

## Evidence labels

- **Verified:** supported by repository implementation, a source record, or a directly linked primary source.
- **Founder-reported:** supplied by the project owner, but not independently measured in this documentation.
- **Planned:** proposed work with a stated outcome; not shipped.
- **Assumption:** a hypothesis that needs evidence.
- **Open risk:** a known uncertainty or dependency that needs mitigation.

When a claim is not verifiable from this repository or a cited source, the docs say so. Testnet transactions are not presented as Mainnet activity, and social-event counts are not presented as verified human adoption.

## Core documents

- [Project overview](https://stelanova.gitbook.io/stelanova-docs/executive-and-investor/stellanova-project-overview), definition, need, users, value proposition, stage, and boundaries.
- [Product requirements](https://stelanova.gitbook.io/stelanova-docs/product/product-requirements), feature map, journeys, requirements, and acceptance criteria.
- [Technical architecture](https://stelanova.gitbook.io/stelanova-docs/technical/technical-architecture), system context, data authority, integrations, and transaction lifecycle.
- [Security and privacy](https://stelanova.gitbook.io/stelanova-docs/security-privacy-and-risk/stellanova-security-and-privacy), trust boundaries, controls, limitations, and response plan.
- [Investor plan](https://stelanova.gitbook.io/stelanova-docs/executive-and-investor/investor-plan), evidence-based thesis, market questions, model, risks, and funding readiness.

## Supporting references

The [repository map](https://stelanova.gitbook.io/stelanova-docs/technical/repository-map), [development setup](https://stelanova.gitbook.io/stelanova-docs/technical/development-setup), [API map](https://stelanova.gitbook.io/stelanova-docs/technical/http-api-reference), [database map](https://stelanova.gitbook.io/stelanova-docs/technical/database-schema), [Stellar contracts](https://stelanova.gitbook.io/stelanova-docs/technical/stellar-and-soroban-contracts), [deployment notes](https://stelanova.gitbook.io/stelanova-docs/technical/ci-deployment-and-operations), and [security controls and gaps](https://stelanova.gitbook.io/stelanova-docs/security-privacy-and-risk/security-controls-and-gaps) document implementation details. [Roadmap and milestones](https://stelanova.gitbook.io/stelanova-docs/governance-and-execution/roadmap-and-milestones), [risk register](https://stelanova.gitbook.io/stelanova-docs/governance-and-execution/risk-register), and [decision log](https://stelanova.gitbook.io/stelanova-docs/governance-and-execution/decision-log) connect the work to execution.

## Scope and non-goals

- NovaMarket's product identity is a **social art marketplace**. Social discovery and creator relationships are core product behavior.
- The current network target documented here is **Stellar Testnet**. Mainnet launch controls are a future milestone and are not implied by the present deployment.
- The current product scope uses **XLM** for Stellar-side commerce flows. Local-currency checkout is out of scope for this version.
- Provenance describes NovaMarket-recorded creation, mint, and indexed chain activity. It does not establish copyright, authorship of off-platform works, or a complete history before an asset enters NovaMarket.
- Collection supply and mint policy are creator-configured; the product should not invent a platform-wide supply cap.
- The dossier does not claim independent security certification, an external audit, validated market size, revenue, partnerships, or broad traction without evidence.

## Document maintenance

The repository at [rhapy01/Stellanova](https://github.com/rhapy01/Stellanova) is the source for implementation details. Product and business claims require a project-owner review. Update status labels when code, deployment, or evidence changes, and keep secrets and private user data out of this public documentation site.
