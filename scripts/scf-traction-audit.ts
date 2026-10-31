import { config as loadEnv } from 'dotenv'
import pg from 'pg'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.join(root, '.env') })

type MintRow = { role: 'founder' | 'user'; recipient_accounts: number; token_mints: number; mint_transactions: number; mints_30d: number; transactions_30d: number }

async function main() {
  if ((process.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase() !== 'TESTNET') {
    throw new Error('This evidence script is Testnet-only; refusing to run against a non-Testnet configuration.')
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Set it locally; its value is never printed.')
  const db = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true },
    ...(new URL(process.env.DATABASE_URL).hostname.endsWith('.neon.tech') ? { sslnegotiation: 'direct' as const } : {}),
  })
  try {
    const result = await db.query<MintRow>(`
      SELECT CASE WHEN LOWER(COALESCE(p.creator_username, '')) IN ('isaacxvoxel', '@isaacxvoxel')
                       OR LOWER(COALESCE(p.email, '')) = 'akintoyeisaac5@gmail.com'
                  THEN 'founder' ELSE 'user' END AS role,
             COUNT(DISTINCT LOWER(v.minter))::int AS recipient_accounts,
             COUNT(*)::int AS token_mints,
             COUNT(DISTINCT v.tx_hash)::int AS mint_transactions,
             COUNT(*) FILTER (WHERE v.created_at >= now() - interval '30 days')::int AS mints_30d,
             COUNT(DISTINCT v.tx_hash) FILTER (WHERE v.created_at >= now() - interval '30 days')::int AS transactions_30d
      FROM verified_nft_mints v
      LEFT JOIN user_profiles p ON LOWER(p.wallet_address) = LOWER(v.minter)
      GROUP BY role
      ORDER BY role
    `)
    const deployments = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM nft_contract_registry WHERE network = 'TESTNET'`)
    console.log('NovaMarket SCF Testnet traction audit')
    console.log(`Generated: ${new Date().toISOString()}`)
    console.log('Source: confirmed indexed on-chain NFT mint events.')
    console.log('Account rule: founder is @isaacxvoxel or akintoyeisaac5@gmail.com; all other recipients are users. No wallet-role classifications are used.')
    console.log(`Verified NFT tokens minted: ${result.rows.reduce((sum, row) => sum + Number(row.token_mints), 0)}`)
    console.log(`NFT contract registry rows (not counted as mints or verified deployments): ${Number(deployments.rows[0]?.count ?? 0)}`)
    console.log('\nMint activity by account role:')
    for (const row of result.rows) {
      console.log(`  ${row.role}: ${row.recipient_accounts} recipient accounts · ${row.token_mints} tokens · ${row.mint_transactions} transactions · last 30d ${row.mints_30d} tokens / ${row.transactions_30d} transactions`)
    }
    console.log('\nEvery account other than the founder account is reported as a user. Transfers, offers, and social events are not counted as mints.')
  } finally {
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'SCF traction audit failed')
  process.exitCode = 1
})
