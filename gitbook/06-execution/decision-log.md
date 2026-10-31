# NovaMarket: Product and Architecture Decision Log

This log records decisions that shape product behavior. It does not replace detailed architecture decision records for implementation-level choices.

| Decision | Current direction | Rationale / constraint | Revisit when |
| --- | --- | --- | --- |
| Product identity | NovaMarket remains a social art marketplace; the social product is central | Creation, publishing, discovery, profiles, and collecting should connect | User research shows a different primary job or target segment |
| Network scope | Current documented deployment is Stellar Testnet | The project is solving Testnet product and contract issues before any Mainnet release | A deliberate Mainnet release review passes |
| Payment scope | Stellar-side commerce uses XLM for now; local currency is out of scope | Keep product/payment behavior coherent for current scope | A new market and compliance case is approved |
| Creator control | Collection supply and mint policy are creator-configured; no invented platform-wide supply cap | Supply is a creator decision and UI/docs must reflect actual contract behavior | Contract/product constraints change and are explicitly reviewed |
| Art tipping | Tips target individual artwork posts in the feed; collection posts are not tip targets | Avoid duplicate collection-level incentives and keep tips in the social context | Product owner approves a new, non-duplicative interaction model |
| Discovery navigation | Exhibitions, creative services, and physical art are distinct pages/experiences | They represent different real-world jobs and should not be hidden as collection subtypes | Navigation research indicates a clearer grouping without merging the underlying categories |
| Provenance boundary | NovaMarket records its own creation/mint workflow and indexed chain activity | The platform cannot establish off-platform authorship or the complete pre-platform history | A verifiable external attestation process is added and its claim scope is reviewed |
| Activity reporting | Social interactions and on-chain mints/trades are separate metrics | Client events are not proof of human activity; ledger facts need chain verification | Metric definitions are versioned with reconciliation evidence |

## Decision record template

- **Date and decision owner:**
- **Context / problem:**
- **Options considered:**
- **Decision and rationale:**
- **Trade-offs and risks:**
- **Evidence required to revisit:**
