# NovaMarket: Business, Operations, and Financial Assumptions

**Status:** Working model outline · **Numbers:** not yet validated or published

This page connects product behavior to the operating and financial questions that must be answered before the project makes a funding or sustainability claim.

## Business model hypotheses

Potential revenue paths to investigate:

- a platform fee on eligible settled marketplace sales, if the deployed contract and product terms actually charge one;
- creator-service listing or completed-service fees, if implemented and disclosed;
- physical-art transaction fees, if implemented and disclosed;
- optional creator tools or promotion, only if a real paid product is designed and tested.

Tips are creator payments and must not be presented as NovaMarket revenue unless the product demonstrably retains a disclosed fee. Collection mints, secondary sales, tips, service requests, physical-art orders, and transfers must be reported separately.

## Operating model

| Workstream | Operating responsibility | Evidence to retain |
| --- | --- | --- |
| Product and engineering | Maintain client, API, database, contracts, and release configuration | Versioned releases, CI results, migration notes, contract IDs, and known limitations |
| Chain operations | Monitor RPC, contract calls, event indexing, and reconciliation | Ledger references, indexer lag, alert delivery records, and reconciliation results |
| Creator support | Explain publishing, mint, marketplace, service, physical-art, and exhibition states | Support cases and categorized friction, excluding unnecessary personal data |
| Payments and commerce | Define payment, cancellation/refund, fulfilment, and dispute responsibilities | XLM transaction references and explicit order/service state transitions |
| Security and privacy | Manage secrets, access, vulnerability response, and data handling | Secret rotation records, incident notes, review findings, and retention policy |

The repository is founder-led and does not establish a staffed operations team, service-level agreement, or 24/7 support function.

## Cost categories for a future model

Actual values must come from invoices, provider usage, or explicit staffing assumptions. Do not substitute generic industry averages.

- engineering and contract review capacity;
- Vercel hosting, database, storage, RPC, email, push, AI generation, and analytics provider costs;
- security review, monitoring, backups, and incident readiness;
- creator onboarding, research, community operations, and customer support;
- payment/commerce support, refunds, delivery issues, and any legal/accounting review required for target markets.

## Financial model requirements

The founder-approved spreadsheet should include:

- monthly fixed and variable costs with source/date for each assumption;
- Testnet versus Mainnet cost boundaries and explicit network-fee treatment;
- revenue streams, platform fee rates, eligibility, and collected amounts;
- creator/collector funnel assumptions and sensitivity ranges;
- base, downside, and upside cases, with runway and break-even logic;
- staffing and technical co-founder/contractor assumptions stated explicitly;
- milestone-by-milestone use of funds and measurable acceptance criteria.

No public funding amount, compensation detail, forecast, or runway is included until the project owner approves the assumptions for publication.

## Operating metrics

Define each metric before using it externally:

- creator activation and repeat creation;
- feed-to-creator/collection visits and social-to-confirmed-mint conversion;
- confirmed Testnet mints and settled sales, reconciled against Stellar;
- distinct repeat creators and collectors with founder/tester activity disclosed;
- marketplace volume definition and supported payment-asset conversion rule;
- creator-service requests, accepted work, paid status, and fulfilment;
- physical-art order requests, paid status, delivery, cancellation, and dispute states;
- uptime, API error rate, indexer lag, failed transaction rate, and notification delivery evidence.

Do not use anonymous client events as the sole evidence for these measures.
