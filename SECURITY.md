# Security

## Scope

StellaNova is currently a Stellar Testnet social marketplace. The hosted app uses Vercel Functions and Firewall, an Express API, PostgreSQL, Privy wallet sessions, and Cloudinary or Cloudflare R2 for media. The app must never ask for or store a user's wallet seed phrase or signing key.

## Current protections

- The production Vercel Firewall applies a per-IP limit of 12 requests per 60 seconds to `/api/ai/*`, before requests reach image-generation providers. Vercel's platform DDoS mitigations are active.
- The API applies security response headers, bounds JSON and multipart request sizes, and has bounded per-process request throttles for API traffic, authentication, and uploads. Per-process limits are a backstop; they do not replace edge rate limiting across serverless instances.
- Media uploads are allowlisted by type and size, checked against file signatures, and stored on separate media-provider domains. SVG, HTML, archives, and executables are not supported. The Cloudinary relay rejects redirects and only returns image media.
- User-authored text is rendered through React's escaping. Server-rendered social metadata and email content use HTML escaping. No raw HTML injection sink was found in the application source during this pass.
- Authentication, cron, and upload-token comparisons use constant-time equality checks. Forwarded IP headers are trusted only when running on Vercel.

## Known gaps

- Upload signature checks establish file format, not cleanliness. There is no antivirus or sandbox scanner yet; a valid image, video, audio, or 3D file could still contain malicious or malformed payloads targeting a downstream decoder. Do not describe uploads as virus-scanned.
- Only AI endpoints currently have a distributed custom rate-limit rule. An additional Vercel rate-limit rule for authentication and upload verification was rejected by the current plan. Local API throttles are per warm process and are not a global DDoS control.
- The production dependency tree still has moderate advisories in transitive wallet-connect / MetaMask packages. The high-severity `ws` advisory was addressed with a scoped dependency override; do not force-downgrade Privy to clear the remaining advisories. Upgrade the wallet stack with sign-in and transaction smoke checks.
- The Content Security Policy currently blocks object embeds, base-URL injection, cross-origin framing, and cross-origin form submission. A strict `script-src` policy has not been enabled because wallet login and connector flows need compatibility testing first.
- Production security changes in application code and `vercel.json` require a deployment to take effect. The AI edge rate-limit rule is already live.

## Reporting

Do not post exploit details, credentials, wallet secrets, or private user data in a public issue. Contact the repository maintainer privately with the affected route, impact, and reproducible steps. Do not include live secrets in a report.
