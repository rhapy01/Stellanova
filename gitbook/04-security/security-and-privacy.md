# NovaMarket: Security and Privacy

**Status:** Repository security summary · **Review scope:** application and contract source in this repository · **External audit:** not claimed

This page describes visible controls and known gaps. It is not a certification, penetration-test report, legal opinion, or guarantee that a deployed environment has the same configuration as the repository.

## Assets and security goals

| Asset | Security goal |
| --- | --- |
| User sessions and wallet identity | Authenticate users and prevent one user from acting as another |
| Wallet-signed transactions | Preserve user control of signing and accurately show the transaction being authorized |
| NFTs, ownership, escrow and sale proceeds | Use Stellar contract/ledger state as the authority for confirmed chain operations |
| User profiles, posts, messages and notifications | Prevent unauthorized reads/writes and minimize exposed personal data |
| Media and generated content | Validate uploads, restrict unsafe content types, and protect provider credentials |
| Admin, database, email and AI credentials | Keep secrets server-side and restrict access |
| Availability and data integrity | Detect degraded services, reconcile chain projections, and recover safely |

## Trust boundaries

1. Browser/client input is untrusted, including usernames, URLs, analytics events, uploaded files, and claimed wallet values.
2. Wallet signatures prove authorization for a specific transaction; they do not prove a user's legal identity or art authorship.
3. PostgreSQL is a mutable application store and chain index, not a substitute for Stellar ledger verification.
4. AI, media, identity, email, push, hosting, and RPC providers are external dependencies with separate credentials and availability risks.
5. Public pages and metadata must not expose credentials, private user data, session material, or authenticated application responses.

## Controls present in the repository

- Wallet routes use verified session/wallet middleware; privileged routes use admin or cron authorization.
- Request limits, security headers, body bounds, and upload size/type checks are present.
- Media validation checks allowed types and file signatures; SVG, HTML, archives, and executables are unsupported.
- React normal text rendering escapes content; server-generated HTML metadata/email paths include escaping logic.
- AI endpoints have edge rate-limit configuration and API code uses bounded process-local throttles.
- Public client configuration and server-only secrets are distinguished; `VITE_` values are exposed to browser code.
- Contract tests and CI workflows are present; they are regression checks, not an independent security audit.

See [Security controls and gaps](https://stelanova.gitbook.io/stelanova-docs/security-privacy-and-risk/security-controls-and-gaps) for the repository-level checklist.

## Known gaps and risks

- Upload validation is not malware scanning or file sandboxing.
- Process-local throttles are not global DDoS protection, and distributed limits do not cover every route.
- A strict script CSP is not enabled because of wallet connector compatibility constraints.
- Dependency advisories, wallet connector changes, provider configuration, and secret rotation require ongoing review.
- No external Soroban contract audit, independent penetration test, verified alert-delivery exercise, or disaster-recovery drill is claimed by this documentation.
- Browser notification delivery depends on browser/device permission and platform behavior; in-app notification records do not prove that a device displayed an alert.
- On-chain data is public. Off-chain profile and social data can still be exposed through application routes, logs, backups, and third-party processors.

## Privacy model

- Stellar transactions and contract events are public and persistent. Do not put private personal data in transaction arguments or public metadata.
- Wallet addresses are pseudonymous identifiers, not anonymous identities; activity can be linked across public chain data.
- Social profiles, posts, follows, comments, tips, and creator-commerce workflows are application data. Access and retention depend on API authorization, database controls, and provider configuration.
- Analytics capture should be minimized and documented. Client-submitted product events must not be described as independently verified users or transactions.
- The provenance feature records NovaMarket workflow and chain evidence. It does not establish legal authorship, copyright ownership, or the off-platform origin of uploaded artwork.

## Threat scenarios to track

| Scenario | Current mitigation | Remaining work |
| --- | --- | --- |
| Forged wallet identity in API request | Verified session middleware on protected routes | Maintain route-by-route authorization tests and integration coverage |
| HTML/script injection through user content or metadata | Escaped text rendering and server-side metadata escaping | Review all rich-text/URL rendering and add an explicit CSP compatible with wallet flows |
| Malicious or deceptive upload | Type/size/signature checks | Add malware scanning or a safe-processing pipeline if the deployment accepts higher-risk files |
| API abuse or denial of service | Request/body bounds and selected rate limits | Add distributed rate limiting, alert thresholds, and load/abuse testing |
| Stale or incorrect chain projection | Indexer and chain event data | Reconciliation jobs, lag alerts, correction audit trail, and recovery drill |
| Secret exposure | Environment-based server credentials | Rotation plan, least-privilege review, secret scanning, and incident procedure |
| Contract flaw or upgrade failure | Rust tests and controlled deployment scripts | Independent review, upgrade authorization review, deployment rehearsal, and recovery plan |
| Provider outage or failed notification | Health/operations endpoints and configured providers | Verify alert delivery, retry policy, provider fallback, and owner escalation |

## Incident response minimum

1. Record detection time, affected user journey, deployment/version, request or transaction references, and current impact.
2. Contain the affected endpoint, credential, contract action, or provider integration without destroying evidence.
3. For chain state, verify the transaction on Stellar and identify whether funds/assets moved before communicating status.
4. Rotate compromised credentials and invalidate affected sessions where applicable.
5. Restore service from a known release/backup, reconcile database projections against chain state, and document user remediation.
6. Publish a concise incident review with root cause, user impact, corrective action, and follow-up owner.

The repository does not establish an on-call team or completed recovery drill. An owner, escalation channel, backup/restore procedure, and alert evidence must be confirmed before claiming operational readiness.
