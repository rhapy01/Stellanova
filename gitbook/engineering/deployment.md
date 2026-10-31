# CI, deployment, and operations

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and pull requests. It installs Node dependencies, type-checks frontend and server/API code, builds the frontend, and runs the account, NFT, and marketplace Soroban test suites.

CI does not run a complete Express/PostgreSQL end-to-end suite. It does not prove that Vercel settings, external credentials, media providers, email, wallet login, or notifications are configured correctly.

## Vercel application

`vercel.json` declares the Vite build/output, security headers, API function duration, crawler/share route rewrites, and scheduled jobs. Connect the intended repository and Vercel project, then configure protected variables from `.env.example`.

## Contract deployments

Package scripts deploy Testnet contracts and require Stellar CLI setup and funded Testnet signing credentials. Review the target network, contract, and script before execution. Contract deployment is separate from frontend deployment; updating source does not update deployed WASM or app contract IDs by itself.

## Monitoring and recovery

The API exposes minimal liveness/readiness and restricted admin diagnostics. Vercel Cron is configured for operations monitoring and marketplace maintenance. Alert delivery requires the corresponding cron secret and email/webhook configuration. A scheduled job entry does not prove an alert was delivered; confirm with an observed run.

Frontend rollback does not reverse Stellar ledger state or contract upgrades. Preserve release artifacts, contract IDs, database backups, and migration notes.
