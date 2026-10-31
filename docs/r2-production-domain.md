# R2 production media domain — runbook

NovaMarket stores canonical NFT media and token metadata as immutable objects in Cloudflare R2
and serves them through a public delivery URL. The current configured base URL is an `r2.dev`
URL:

```
CLOUDFLARE_R2_PUBLIC_BASE_URL=https://pub-XXXXXXXX.r2.dev
```

Cloudflare explicitly documents the `*.r2.dev` URL as a **non-production** development URL.
It is not rate-limited nor guaranteed as a stable delivery endpoint and is not suitable for a
live marketplace. Before production launch, attach a **custom domain** to the public bucket and
point `CLOUDFLARE_R2_PUBLIC_BASE_URL` at it.

## Why a custom domain

- Stable, cacheable delivery through Cloudflare's edge (WAF, caching, access controls).
- Removes dependency on the `r2.dev` dev URL.
- Lets the NFT token URI remain durable: the metadata and media paths never change even as
  buckets/regions are moved.
- Cleaner, brandable URLs for collectors and secondary marketplaces.

## Prerequisites

- A domain you own (or a subdomain) whose DNS you can control on Cloudflare.
- The R2 bucket already created and the S3-compatible credentials configured
  (`CLOUDFLARE_R2_ENDPOINT`, `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`,
  `CLOUDFLARE_R2_BUCKET`).
- The bucket made **public** (R2 public access enabled on the bucket).

## Steps (Cloudflare dashboard)

1. **Enable public access on the bucket**
   - Cloudflare Dashboard → **R2** → select the bucket → **Settings** → **Public access**.
   - Toggle **Allow public access** and enable the **Custom domain** option. A custom-domain
     public bucket needs "Allow public access" on.

2. **Attach a custom domain**
   - In the same bucket's **Custom domains** section, choose **Connect domain**.
   - Enter the subdomain, e.g. `media.nftgram.io` (the parent zone must be a Cloudflare zone you
     control).
   - Cloudflare will create a `CNAME` (`media.nftgram.io` → `<bucket-id>.r2.cloudflarestorage.com`).
     Use **Proxied** mode so traffic flows through Cloudflare (cache + WAF + TLS).
   - Wait for the domain to become **Active** (usually seconds–minutes).

3. **Verify delivery**
   - Upload a test object, then confirm it loads at the custom domain:
     `https://media.nftgram.io/nftgram/originals/<key>`.
   - Confirm TLS is valid and the edge serves it.

4. **Point NovaMarket at the custom domain**
   - Set both the server and client env vars to the custom base URL (no trailing slash):
     ```
     CLOUDFLARE_R2_PUBLIC_BASE_URL=https://media.nftgram.io
     VITE_CLOUDFLARE_R2_PUBLIC_BASE_URL=https://media.nftgram.io
     ```
   - Restart the server and rebuild the frontend.

5. **Confirm production readiness**
   - Open **Media admin** (`/admin/media`). The **R2 delivery domain** row should read
     `Production custom domain`, not `Non-production r2.dev`.
   - The server's `/api/media/health` returns `r2.productionDomain: true` when on a custom
     domain.

## Code-side production-readiness guard

The server signals whether it is still on `r2.dev`:

- `GET /api/media/health` → `r2: { baseUrl, productionDomain, describesOnR2Dev }`
- `GET /api/media/providers` → `cloudflare.onR2Dev` / `cloudflare.productionDomain`

The media admin surfaces this so the operator can verify during deployment.

## Canonical metadata linkage

`POST /api/media/metadata` uploads the SEP-50-compatible token metadata JSON to R2 and persists
the linkage in the `canonical_metadata` table:

| column         | purpose                                        |
| -------------- | ---------------------------------------------- |
| `token_id`     | the minted token id                            |
| `contract_id`  | the SEP-50 NFT contract id                     |
| `object_key`   | the R2 object key (e.g. `nftgram/metadata/0.json`) |
| `metadata_uri` | the public delivery URL for the metadata       |
| `sha256`       | content hash of the metadata JSON              |
| `content_type` | `application/json`                             |
| `bytes`        | size in bytes                                  |

The NFT contract's `token_uri` should point to the `metadata_uri`. Because the SEP-50 `Base`
uses a single base `token_uri` set at construction, keep the custom-domain base URL stable and
durable (content-addressed keys under `nftgram/`).

## When to deprecate r2.dev

Once the custom domain is Active and verified, you can disable the `r2.dev` dev domain on the
bucket (Settings → Public access → toggle the r2.dev dev domain off) so object URLs are only
served from the production domain.
