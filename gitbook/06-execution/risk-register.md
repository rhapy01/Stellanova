# NovaMarket: Risk Register

**Status:** Initial repository-based register · **Owner:** project owner unless reassigned · **Review cadence:** before each material release

Ratings are qualitative because incident likelihood and financial impact have not yet been measured. They are priorities for action, not a completed audit.

| ID | Risk | Likelihood / impact | Mitigation or next evidence | State |
| --- | --- | --- | --- | --- |
| R1 | Creators may not finish the path from artwork/collection setup to a confirmed mint | Medium / High | Observe first-time journeys; instrument stage drop-off using privacy-conscious, verified events; fix blockers and retest | Open product risk |
| R2 | Social activity may be mistaken for independent traction | High / High | Separate client events from verified chain metrics; publish definitions, periods, and disclosed founder/tester activity | Open reporting risk |
| R3 | Stellar marketplace/creator products already solve parts of the proposed value | High / High | Research current alternatives and interview artists/collectors; state a narrow, evidence-backed distinction | Open strategy risk |
| R4 | Testnet environment is confused with production/Mainnet readiness | Medium / High | Label network in the UI/docs, verify deployment variables, and require a Mainnet release gate | Open release risk |
| R5 | PostgreSQL indexer projection is stale or inconsistent with ledger state | Medium / High | Track indexer lag, reconcile chain events, retain corrections, and test replay/recovery | Open operational risk |
| R6 | Contract behavior or upgrade/deployment error affects NFTs or escrow | Medium / Critical | Contract tests, independent review, deployment rehearsals, signer controls, and explicit version compatibility matrix | Open technical risk |
| R7 | Malicious uploads or abusive traffic harm users or availability | Medium / High | Add distributed rate limits, upload scanning decision, abuse monitoring, and incident response | Open security risk |
| R8 | Creator services and physical-art orders create disputes that software cannot settle | Medium / High | Publish payment/refund/fulfilment responsibilities and define support/escalation paths before broader rollout | Open operations risk |
| R9 | Third-party AI, identity, RPC, storage, email, or push service outage blocks journeys | Medium / Medium | Monitor provider-specific failures, define retries/fallbacks, and avoid promising delivery guarantees | Open dependency risk |
| R10 | Business model and unit economics are unvalidated | High / High | Build cost/revenue assumptions from actual transaction and provider costs; validate willingness to pay | Open business risk |
| R11 | Founder capacity is a single point of failure | High / High | Prioritize documentation, reproducible release/backup procedures, and recruit/contract for critical gaps as funded | Open execution risk |
| R12 | Public provenance is read as proof of authorship or copyright | Medium / High | Use precise copy: platform-recorded workflow and chain activity only; avoid legal/ownership claims beyond ledger semantics | Open product/legal risk |

## Review fields to add for active risks

For each risk selected for active mitigation, record a named owner, next action, target date, evidence of completion, and residual risk. Do not mark risks closed because a document mentions them; close them only after the mitigation is verified.
