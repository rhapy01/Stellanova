# Security controls and gaps

This is a code-oriented summary, not a security certification or third-party audit. The repository also contains a `SECURITY.md` file with additional implementation notes.

## Implemented controls

- Protected wallet routes use verified session/wallet middleware.
- API response headers and request/body/upload bounds are configured.
- AI endpoints have a Vercel edge rate-limit rule; API code also applies bounded process-local throttles.
- Media types and sizes are allowlisted and file signatures checked; SVG, HTML, archives, and executables are unsupported.
- React escapes normal text rendering; server-generated email/social metadata escapes HTML content.
- Server credentials belong in protected deployment settings; `VITE_` variables are public client configuration.

## Known limitations

- Upload signature validation does not scan for malware or sandbox files.
- Process-local throttles are not global DDoS protection; distributed limits are not present on every route.
- A strict `script-src` CSP is not enabled due to wallet connector compatibility requirements.
- Transitive wallet dependency advisories require ongoing review.
- Contract unit tests do not replace independent review, key-custody review, or recovery drills.

## Secret handling

Never commit populated `.env` files, wallet secrets, API tokens, database credentials, SMTP credentials, or storage keys. Do not put private user data in GitBook. Report suspected vulnerabilities privately to the maintainer and do not publish credentials or exploit payloads.
