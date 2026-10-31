# NovaMarket: Roadmap and Milestones

**Status:** Stage-gated plan · **Dates:** deliberately omitted until estimates and dependencies are confirmed

The current product is on Stellar Testnet. Milestones below describe outcomes and evidence gates rather than promise dates. A milestone is complete only when its acceptance evidence is recorded.

## Milestone 1, Make core journeys observable and recoverable

**Outcome:** creators and collectors can complete the main social, mint, and marketplace journeys with clear state and useful operations signals.

**Acceptance evidence**

- Documented flow-level tests cover signup/session restore, standard collection creation, mint confirmation/indexing, listing/purchase, and social art publishing/tipping.
- A transaction reconciliation view or report distinguishes submitted, confirmed, indexed, failed, expired, and recovered states.
- Operations alerts identify the failing user action and affected service, include request/transaction context, and have a verified delivery record.
- A recovery drill documents how to restore a database projection from Stellar ledger events and how to roll back a web release without implying chain rollback.

## Milestone 2, Validate the social-to-collecting product thesis

**Outcome:** NovaMarket can report whether social discovery leads to repeat creator activity and confirmed Stellar collecting.

**Acceptance evidence**

- Metric definitions separate posts, reactions, tips, mints, primary mint revenue, transfers, offers, settled sales, and marketplace volume.
- Chain events are reconciled against Stellar before being reported as verified on-chain activity.
- Founder/tester wallets are classified according to the project owner's stated rules and excluded or disclosed consistently in external reporting.
- A cohort report records repeat creators/collectors and funnel conversion without treating anonymous client events as proof of human adoption.

## Milestone 3, Demonstrate Stellar-specific product value

**Outcome:** public technical and product materials explain what Stellar enables in NovaMarket and how funded work creates additional Stellar use.

**Acceptance evidence**

- A current architecture describes Stellar transaction flows, contracts, fee/royalty behavior, wallet options, and indexer boundaries.
- Testnet evidence captures creator-configured collections, confirmed mints, marketplace actions, and transaction references.
- Contract changes have tests, deployment controls, upgrade/compatibility documentation, and independent review appropriate to the operation.
- A deliberate Mainnet readiness review is completed before any Mainnet migration or asset-risking transaction.

## Milestone 4, Complete creator-commerce operating rules

**Outcome:** service, physical-art, and exhibition workflows have clear expectations beyond creating a listing.

**Acceptance evidence**

- Each page explains request/order status, payment status, cancellation/refund responsibility, fulfilment expectations, and support contact.
- Physical-art shipping, delivery, and dispute boundaries are explicit for supported launch regions.
- Exhibition schedule/location changes and completed/past event states are handled consistently.
- Service booking and payment behavior is stated accurately; a request is never represented as a confirmed booking without provider acceptance.

## Milestone 5, Prepare the business and funding case

**Outcome:** funding claims and financial planning are based on evidence and transparent assumptions.

**Acceptance evidence**

- A sourced market/competitor scan identifies alternatives and a defensible product distinction.
- User-need evidence records interview or product research methods and findings; no demand is inferred from integration count.
- Costs, revenue drivers, fees, provider spend, staffing, runway, and downside assumptions are reconciled in a founder-approved financial model.
- Any grant/investor ask is tied to measurable deliverables, a time period, and a milestone budget.
- No revenue, partnership, market size, award, or audit claim appears without traceable evidence.

## Mainnet gate

Mainnet is a separate decision, not a prerequisite for this Testnet documentation or for an interest-stage conversation. Before a Mainnet switch, require a reviewed contract/version matrix, signer/key custody plan, deployment rehearsal, migration/release procedure, monitoring and incident drills, and explicit product-owner approval.
