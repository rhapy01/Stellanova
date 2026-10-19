import pg, { type Pool } from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'

let pool: Pool | null = null
let schemaReady: Promise<void> | null = null
const transactionContext = new AsyncLocalStorage<pg.PoolClient>()

export function databaseAvailable() {
  return Boolean(process.env.DATABASE_URL)
}

/** Lightweight read-only probe that does not run schema migrations. */
export async function checkDatabaseConnection(): Promise<{ ok: true; latencyMs: number } | { ok: false }> {
  const db = getPool()
  if (!db) return { ok: false }
  const startedAt = Date.now()
  try {
    await db.query('SELECT 1')
    return { ok: true, latencyMs: Date.now() - startedAt }
  } catch {
    return { ok: false }
  }
}

/** Read the durable indexer checkpoint without invoking schema setup. */
export async function readIndexerCheckpoint(): Promise<{ nextLedger: number; updatedAt: string } | null> {
  const db = getPool()
  if (!db) return null
  try {
    const result = await db.query<{ next_ledger: number; updated_at: Date | string }>(
      `SELECT next_ledger, updated_at FROM indexer_state WHERE name = 'stellar-events' LIMIT 1`,
    )
    const row = result.rows[0]
    if (!row) return null
    return { nextLedger: Number(row.next_ledger), updatedAt: new Date(row.updated_at).toISOString() }
  } catch {
    return null
  }
}

function getPool() {
  if (!process.env.DATABASE_URL) return null
  const connectionString = process.env.DATABASE_URL
  let sslnegotiation: 'direct' | undefined
  try {
    // Neon endpoints expect PostgreSQL's direct TLS negotiation. The older
    // SSLRequest handshake completes TCP/TLS but stalls before PostgreSQL
    // authentication, which makes every API query time out.
    if (new URL(connectionString).hostname.endsWith('.neon.tech')) sslnegotiation = 'direct'
  } catch {
    // Let pg report malformed or non-URL connection strings normally.
  }
  pool ??= new pg.Pool({
    connectionString,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: { rejectUnauthorized: true },
    ...(sslnegotiation ? { sslnegotiation } : {}),
  })
  return pool
}

/**
 * Translate MySQL-style `?` placeholders to Postgres `$1, $2, …` positional
 * parameters so query call sites can keep using `?` unchanged.
 */
function convertPlaceholders(sql: string) {
  let index = 0
  return sql.replace(/\?/g, () => {
    index += 1
    return `$${index}`
  })
}

export async function ensureSchema() {
  const db = getPool()
  if (!db) return
  if (!schemaReady) {
    const pending = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS nftgram_schema (version INT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`)
    const currentSchema = await db.query<{ version: number }>('SELECT COALESCE(MAX(version), 0)::int AS version FROM nftgram_schema')
    if (Number(currentSchema.rows[0]?.version ?? 0) >= 23) return
    const statements = [
      `CREATE TABLE IF NOT EXISTS collection_subscriptions (wallet_address VARCHAR(56) NOT NULL, collection_id VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, collection_id))`,
      `CREATE TABLE IF NOT EXISTS collection_likes (wallet_address VARCHAR(56) NOT NULL, collection_id VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, collection_id))`,
      `CREATE TABLE IF NOT EXISTS collection_dislikes (wallet_address VARCHAR(56) NOT NULL, collection_id VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, collection_id))`,
      `CREATE TABLE IF NOT EXISTS collection_comments (id BIGSERIAL PRIMARY KEY, wallet_address VARCHAR(56) NOT NULL, collection_id VARCHAR(128) NOT NULL, body VARCHAR(1000) NOT NULL, parent_id BIGINT, created_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS collection_comments_item ON collection_comments (collection_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS nft_likes (wallet_address VARCHAR(56) NOT NULL, nft_id VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, nft_id))`,
      `CREATE TABLE IF NOT EXISTS nft_dislikes (wallet_address VARCHAR(56) NOT NULL, nft_id VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, nft_id))`,
      `CREATE TABLE IF NOT EXISTS nft_comments (id BIGSERIAL PRIMARY KEY, wallet_address VARCHAR(56) NOT NULL, nft_id VARCHAR(128) NOT NULL, body VARCHAR(1000) NOT NULL, parent_id BIGINT, created_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS nft_bookmarks (wallet_address VARCHAR(56) NOT NULL, nft_id VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, nft_id))`,
      `ALTER TABLE nft_comments ADD COLUMN IF NOT EXISTS parent_id BIGINT`,
      `CREATE INDEX IF NOT EXISTS nft_comments_item ON nft_comments (nft_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS notifications (id BIGSERIAL PRIMARY KEY, wallet_address VARCHAR(56) NOT NULL, kind VARCHAR(64) NOT NULL, title VARCHAR(255) NOT NULL, body VARCHAR(1000) NOT NULL, read_at TIMESTAMPTZ NULL, created_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS notifications_wallet ON notifications (wallet_address, created_at)`,
      `CREATE TABLE IF NOT EXISTS nft_ownership (contract_id VARCHAR(56) NOT NULL, token_id INT NOT NULL, owner_address VARCHAR(56) NOT NULL, ledger INT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (contract_id, token_id))`,
      `CREATE TABLE IF NOT EXISTS verified_nft_mints (contract_id VARCHAR(56) NOT NULL, token_id INT NOT NULL, minter VARCHAR(56) NOT NULL, tx_hash VARCHAR(64) NOT NULL, ledger INT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (contract_id, token_id))`,
      `CREATE TABLE IF NOT EXISTS stage_mint_events (contract_id VARCHAR(56) NOT NULL, tx_hash VARCHAR(64) NOT NULL, stage_id INT NOT NULL, wallet VARCHAR(56) NOT NULL, token_ids INT[] NOT NULL, ledger INT NOT NULL, PRIMARY KEY (contract_id, tx_hash, stage_id))`,
      `CREATE INDEX IF NOT EXISTS nft_ownership_owner ON nft_ownership (owner_address)`,
      `CREATE TABLE IF NOT EXISTS marketplace_listings (listing_id INT PRIMARY KEY, seller VARCHAR(56) NOT NULL, nft_contract VARCHAR(56) NOT NULL, token_id INT NOT NULL, payment_token VARCHAR(56) NOT NULL, price NUMERIC(40,0) NOT NULL, expires_at INT NOT NULL, active BOOLEAN NOT NULL, ledger INT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS listings_active ON marketplace_listings (active, expires_at)`,
      `CREATE TABLE IF NOT EXISTS marketplace_offers (offer_id INT PRIMARY KEY, buyer VARCHAR(56) NOT NULL, nft_contract VARCHAR(56) NOT NULL, token_id INT NOT NULL, payment_token VARCHAR(56) NOT NULL, amount NUMERIC(40,0) NOT NULL, expires_at BIGINT NOT NULL, active BOOLEAN NOT NULL, ledger INT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`,
      `ALTER TABLE marketplace_offers ALTER COLUMN expires_at TYPE BIGINT USING expires_at::BIGINT`,
      `ALTER TABLE marketplace_offers ADD COLUMN IF NOT EXISTS contract_id VARCHAR(56) NOT NULL DEFAULT ''`,
      `ALTER TABLE marketplace_offers ALTER COLUMN contract_id DROP DEFAULT`,
      `CREATE TABLE IF NOT EXISTS marketplace_offer_responses (offer_id INT PRIMARY KEY, seller VARCHAR(56) NOT NULL, buyer VARCHAR(56) NOT NULL, status VARCHAR(24) NOT NULL, counter_amount NUMERIC(40,0), updated_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS offers_active ON marketplace_offers (active, expires_at)`,
      `ALTER TABLE marketplace_offers ADD COLUMN IF NOT EXISTS expiry_reminder_sent_at TIMESTAMPTZ NULL`,
      `CREATE TABLE IF NOT EXISTS marketplace_events (id BIGSERIAL PRIMARY KEY, event_key VARCHAR(255) NOT NULL UNIQUE, event_type VARCHAR(64) NOT NULL, contract_id VARCHAR(56) NOT NULL, tx_hash VARCHAR(64) NOT NULL, ledger INT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS indexer_state (name VARCHAR(64) PRIMARY KEY, next_ledger INT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS events_ledger ON marketplace_events (ledger)`,
      `CREATE TABLE IF NOT EXISTS canonical_metadata (token_id INT PRIMARY KEY, contract_id VARCHAR(56) NOT NULL, object_key VARCHAR(512) NOT NULL, metadata_uri VARCHAR(1024) NOT NULL, sha256 VARCHAR(64) NOT NULL, content_type VARCHAR(128) NOT NULL, bytes INT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canonical_metadata_contract_id_token_id_pkey') THEN ALTER TABLE canonical_metadata DROP CONSTRAINT IF EXISTS canonical_metadata_pkey; ALTER TABLE canonical_metadata ADD CONSTRAINT canonical_metadata_contract_id_token_id_pkey PRIMARY KEY (contract_id, token_id); END IF; END $$`,
      `CREATE TABLE IF NOT EXISTS token_collections (contract_id VARCHAR(56) NOT NULL, token_id INT NOT NULL, collection_id VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (contract_id, token_id))`,
      `CREATE INDEX IF NOT EXISTS token_collections_collection ON token_collections (collection_id)`,
      `CREATE TABLE IF NOT EXISTS posts (id BIGSERIAL PRIMARY KEY, author VARCHAR(128) NOT NULL, author_name VARCHAR(128) NOT NULL DEFAULT '', avatar VARCHAR(512) NOT NULL DEFAULT '', media_url VARCHAR(1024) NOT NULL DEFAULT '', media_type VARCHAR(32) NOT NULL DEFAULT 'image', caption VARCHAR(1000) NOT NULL DEFAULT '', linked_nft_id VARCHAR(128), post_kind VARCHAR(16) NOT NULL DEFAULT 'post', price_xlm DECIMAL(18,7), created_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS collection_stories (id BIGSERIAL PRIMARY KEY, collection_id VARCHAR(128) NOT NULL, owner_wallet VARCHAR(56) NOT NULL, media_url VARCHAR(1024) NOT NULL DEFAULT '', media_type VARCHAR(16) NOT NULL DEFAULT 'image', caption VARCHAR(500) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS collection_stories_expiry ON collection_stories (collection_id, expires_at DESC)`,
      `CREATE INDEX IF NOT EXISTS posts_author ON posts (author)`,
      `CREATE INDEX IF NOT EXISTS posts_created ON posts (created_at DESC)`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE`,
      `DELETE FROM posts WHERE is_demo = TRUE`,
      `ALTER TABLE posts DROP COLUMN IF EXISTS is_demo`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_kind VARCHAR(16) NOT NULL DEFAULT 'post'`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS price_xlm DECIMAL(18,7)`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS author_type VARCHAR(16) NOT NULL DEFAULT 'user'`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS collection_id VARCHAR(128)`,
      `CREATE INDEX IF NOT EXISTS posts_collection_created ON posts (collection_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS post_likes (wallet_address VARCHAR(56) NOT NULL, post_id BIGINT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, post_id))`,
      `CREATE TABLE IF NOT EXISTS post_dislikes (wallet_address VARCHAR(56) NOT NULL, post_id BIGINT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, post_id))`,
      `CREATE TABLE IF NOT EXISTS post_comments (id BIGSERIAL PRIMARY KEY, wallet_address VARCHAR(56) NOT NULL, post_id BIGINT NOT NULL, body VARCHAR(1000) NOT NULL, parent_id BIGINT, created_at TIMESTAMPTZ DEFAULT now())`,
      `ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS parent_id BIGINT`,
      `CREATE INDEX IF NOT EXISTS post_comments_post ON post_comments (post_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS creator_follows (wallet_address VARCHAR(56) NOT NULL, creator_id VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, creator_id))`,
      `CREATE TABLE IF NOT EXISTS post_reposts (wallet_address VARCHAR(56) NOT NULL, post_id BIGINT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (wallet_address, post_id))`,
      `CREATE TABLE IF NOT EXISTS user_profiles (wallet_address VARCHAR(56) PRIMARY KEY, display_name VARCHAR(80) NOT NULL DEFAULT '', avatar VARCHAR(512) NOT NULL DEFAULT '', bio VARCHAR(500) NOT NULL DEFAULT '', is_creator BOOLEAN NOT NULL DEFAULT FALSE, is_admin BOOLEAN NOT NULL DEFAULT FALSE, is_verified BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`,
      `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ`,
      `UPDATE user_profiles SET welcome_email_sent_at = now() WHERE welcome_email_sent_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS collections (id BIGSERIAL PRIMARY KEY, owner_wallet VARCHAR(56) NOT NULL, slug VARCHAR(160) NOT NULL, name VARCHAR(160) NOT NULL, symbol VARCHAR(20) NOT NULL, description VARCHAR(1000) NOT NULL DEFAULT '', cover VARCHAR(1024) NOT NULL DEFAULT '', is_verified BOOLEAN NOT NULL DEFAULT FALSE, verification_status VARCHAR(16) NOT NULL DEFAULT 'pending', verified_by VARCHAR(56), verified_at TIMESTAMPTZ, contract_id VARCHAR(56), created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (slug))`,
      `CREATE INDEX IF NOT EXISTS collections_owner ON collections (owner_wallet)`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS contract_id VARCHAR(56)`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS total_supply INT`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS website_url VARCHAR(500)`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '{}'::jsonb`,
      `CREATE TABLE IF NOT EXISTS nft_contract_registry (contract_id VARCHAR(56) PRIMARY KEY, owner_wallet VARCHAR(56) NOT NULL, network VARCHAR(16) NOT NULL DEFAULT 'TESTNET', created_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS nft_mints (contract_id VARCHAR(56) NOT NULL, token_id INT NOT NULL, minter VARCHAR(56) NOT NULL, collection_id VARCHAR(128) NOT NULL, title VARCHAR(160) NOT NULL DEFAULT '', image VARCHAR(1024) NOT NULL DEFAULT '', price_xlm DECIMAL(18,7), metadata_uri VARCHAR(1024) NOT NULL DEFAULT '', created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (contract_id, token_id))`,
      `ALTER TABLE nft_mints ADD COLUMN IF NOT EXISTS stage_id INT`,
      `CREATE INDEX IF NOT EXISTS nft_mints_collection ON nft_mints (collection_id)`,
      `CREATE INDEX IF NOT EXISTS nft_mints_minter ON nft_mints (minter)`,
      `CREATE TABLE IF NOT EXISTS mint_stages (id BIGSERIAL PRIMARY KEY, collection_id VARCHAR(128) NOT NULL, kind VARCHAR(16) NOT NULL, name VARCHAR(160) NOT NULL DEFAULT '', start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, price_xlm DECIMAL(18,7), per_wallet_limit INT NOT NULL DEFAULT 1, max_supply INT, sort_order INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS mint_stages_collection ON mint_stages (collection_id, sort_order)`,
      `CREATE TABLE IF NOT EXISTS creator_nft_metadata (metadata_uri VARCHAR(1024) PRIMARY KEY, collection_id VARCHAR(128) NOT NULL, creator_wallet VARCHAR(56) NOT NULL, object_key VARCHAR(512) NOT NULL, sha256 VARCHAR(64) NOT NULL, bytes INT NOT NULL DEFAULT 0, name VARCHAR(160) NOT NULL, description VARCHAR(2000) NOT NULL DEFAULT '', image VARCHAR(1024) NOT NULL, attributes JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ DEFAULT now())`,
      `ALTER TABLE creator_nft_metadata ADD COLUMN IF NOT EXISTS animation_url VARCHAR(1024)`,
      `ALTER TABLE mint_stages ADD COLUMN IF NOT EXISTS metadata_uris JSONB NOT NULL DEFAULT '[]'::jsonb`,
      `ALTER TABLE mint_stages ADD COLUMN IF NOT EXISTS edition_count INT NOT NULL DEFAULT 1`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS revealed BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS placeholder_metadata_uri VARCHAR(1024)`,
      `ALTER TABLE nft_mints ADD COLUMN IF NOT EXISTS animation_url VARCHAR(1024)`,
      `ALTER TABLE stage_mint_events ADD COLUMN IF NOT EXISTS edition_start INT NOT NULL DEFAULT 0`,
      `CREATE TABLE IF NOT EXISTS creator_media_uploads (image_url VARCHAR(1024) PRIMARY KEY, collection_id VARCHAR(128) NOT NULL, creator_wallet VARCHAR(56) NOT NULL, object_key VARCHAR(512) NOT NULL, sha256 VARCHAR(64) NOT NULL, content_type VARCHAR(128) NOT NULL, bytes INT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`,
      `ALTER TABLE creator_nft_metadata ADD COLUMN IF NOT EXISTS bytes INT NOT NULL DEFAULT 0`,
      `ALTER TABLE mint_stages ADD COLUMN IF NOT EXISTS metadata_uri VARCHAR(1024) NOT NULL DEFAULT ''`,
      `ALTER TABLE mint_stages ADD COLUMN IF NOT EXISTS metadata_name VARCHAR(160) NOT NULL DEFAULT ''`,
      `ALTER TABLE mint_stages ADD COLUMN IF NOT EXISTS metadata_image VARCHAR(1024) NOT NULL DEFAULT ''`,
      `ALTER TABLE mint_stages ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE`,
      `CREATE TABLE IF NOT EXISTS mint_whitelist (id BIGSERIAL PRIMARY KEY, stage_id INT NOT NULL, wallet VARCHAR(56) NOT NULL, custom_limit INT, custom_price DECIMAL(18,7), created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (stage_id, wallet))`,
      `CREATE TABLE IF NOT EXISTS collection_drop_drafts (collection_id VARCHAR(128) PRIMARY KEY, owner_wallet VARCHAR(56) NOT NULL, setup JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE TABLE IF NOT EXISTS creator_collection_archive (wallet_address VARCHAR(56) NOT NULL, collection_slug VARCHAR(160) NOT NULL, artwork_count INT NOT NULL DEFAULT 0, archived_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (wallet_address, collection_slug))`,
      `CREATE INDEX IF NOT EXISTS creator_collection_archive_wallet ON creator_collection_archive (wallet_address, archived_at DESC)`,
      `CREATE INDEX IF NOT EXISTS mint_whitelist_wallet ON mint_whitelist (wallet)`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS verification_status VARCHAR(16) NOT NULL DEFAULT 'pending'`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS verified_by VARCHAR(56)`,
      `ALTER TABLE collections ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`,
      `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email VARCHAR(320)`,
      `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS creator_username VARCHAR(24)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_creator_username_unique ON user_profiles (lower(creator_username)) WHERE creator_username IS NOT NULL AND creator_username <> ''`,
      `ALTER TABLE nft_mints ALTER COLUMN stage_id TYPE BIGINT USING stage_id::bigint`,
      `ALTER TABLE mint_whitelist ALTER COLUMN stage_id TYPE BIGINT USING stage_id::bigint`,
      `ALTER TABLE stage_mint_events ALTER COLUMN stage_id TYPE BIGINT USING stage_id::bigint`,
      `CREATE TABLE IF NOT EXISTS wallet_auth_challenges (challenge_id UUID PRIMARY KEY, wallet_address VARCHAR(56) NOT NULL, message TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS wallet_auth_challenges_expiry ON wallet_auth_challenges (expires_at)`,
      `CREATE TABLE IF NOT EXISTS wallet_sessions (token_hash VARCHAR(64) PRIMARY KEY, wallet_address VARCHAR(56) NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS wallet_sessions_expiry ON wallet_sessions (expires_at)`,
      `CREATE TABLE IF NOT EXISTS social_funnel_events (event_id UUID PRIMARY KEY, anonymous_id UUID NOT NULL, share_id UUID, event_type VARCHAR(16) NOT NULL, entity_kind VARCHAR(16), entity_id VARCHAR(160), created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS social_funnel_events_created ON social_funnel_events (created_at)`,
      `CREATE INDEX IF NOT EXISTS social_funnel_events_share ON social_funnel_events (share_id, event_type)`
    ]
    for (const statement of statements) await db.query(statement)
    await db.query(`ALTER TABLE nft_mints ALTER COLUMN collection_id DROP NOT NULL`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (2) ON CONFLICT (version) DO NOTHING`)
    // Keep updated_at fresh with a helper trigger for tables that had MySQL ON UPDATE CURRENT_TIMESTAMP.
    await db.query(`CREATE OR REPLACE FUNCTION nftgram_touch_updated() RETURNS trigger AS $$
      BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql`)
    for (const table of ['nft_ownership', 'marketplace_listings', 'marketplace_offers']) {
      await db.query(`DROP TRIGGER IF EXISTS ${table}_touch ON ${table}`)
      await db.query(`CREATE TRIGGER ${table}_touch BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION nftgram_touch_updated()`)
    }

    // Remove the two known pre-launch placeholder records. Restrict the
    // collection cleanup to the original placeholder owner and unminted row.
    const placeholderWallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
    const placeholderCollection = 'qo-quiet-orbit'
    const placeholderPost = `author = '${placeholderWallet}' AND caption = 'test drop' AND linked_nft_id = 'quiet-orbit'`
    await db.query(`DELETE FROM post_likes WHERE post_id IN (SELECT id FROM posts WHERE ${placeholderPost})`)
    await db.query(`DELETE FROM post_comments WHERE post_id IN (SELECT id FROM posts WHERE ${placeholderPost})`)
    await db.query(`DELETE FROM post_reposts WHERE post_id IN (SELECT id FROM posts WHERE ${placeholderPost})`)
    await db.query(`DELETE FROM posts WHERE ${placeholderPost}`)
    await db.query('DELETE FROM collection_subscriptions WHERE collection_id = $1 AND EXISTS (SELECT 1 FROM collections WHERE slug = $2 AND owner_wallet = $3 AND contract_id IS NULL)', [placeholderCollection, placeholderCollection, placeholderWallet])
    await db.query('DELETE FROM mint_whitelist WHERE stage_id IN (SELECT id FROM mint_stages WHERE collection_id = $1) AND EXISTS (SELECT 1 FROM collections WHERE slug = $2 AND owner_wallet = $3 AND contract_id IS NULL)', [placeholderCollection, placeholderCollection, placeholderWallet])
    await db.query('DELETE FROM mint_stages WHERE collection_id = $1 AND EXISTS (SELECT 1 FROM collections WHERE slug = $2 AND owner_wallet = $3 AND contract_id IS NULL)', [placeholderCollection, placeholderCollection, placeholderWallet])
    await db.query('DELETE FROM creator_media_uploads WHERE collection_id = $1 AND EXISTS (SELECT 1 FROM collections WHERE slug = $2 AND owner_wallet = $3 AND contract_id IS NULL)', [placeholderCollection, placeholderCollection, placeholderWallet])
    await db.query('DELETE FROM creator_nft_metadata WHERE collection_id = $1 AND EXISTS (SELECT 1 FROM collections WHERE slug = $2 AND owner_wallet = $3 AND contract_id IS NULL)', [placeholderCollection, placeholderCollection, placeholderWallet])
    await db.query('DELETE FROM collections WHERE slug = $1 AND owner_wallet = $2 AND contract_id IS NULL AND NOT EXISTS (SELECT 1 FROM nft_mints WHERE collection_id = $3)', [placeholderCollection, placeholderWallet, placeholderCollection])
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (3) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (4) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (5) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (6) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (7) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (8) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (9) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (10) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (11) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (12) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (13) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (14) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (15) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (16) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (17) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (18) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (19) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (20) ON CONFLICT (version) DO NOTHING`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (21) ON CONFLICT (version) DO NOTHING`)
    await db.query(`DROP TABLE IF EXISTS social_funnel_events`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (22) ON CONFLICT (version) DO NOTHING`)
    await db.query(`CREATE TABLE IF NOT EXISTS ops_alert_state (alert_key VARCHAR(96) PRIMARY KEY, status VARCHAR(24) NOT NULL, last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_result VARCHAR(64) NOT NULL DEFAULT 'pending')`)
    await db.query(`CREATE TABLE IF NOT EXISTS ops_reconciliation_runs (id BIGSERIAL PRIMARY KEY, checked INT NOT NULL, mismatches INT NOT NULL, repaired INT NOT NULL, failed INT NOT NULL, latest_ledger INT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    await db.query(`ALTER TABLE ops_reconciliation_runs ADD COLUMN IF NOT EXISTS metadata_repaired INT NOT NULL DEFAULT 0`)
    await db.query(`ALTER TABLE ops_reconciliation_runs ADD COLUMN IF NOT EXISTS metadata_failed INT NOT NULL DEFAULT 0`)
    await db.query(`INSERT INTO nftgram_schema (version) VALUES (23) ON CONFLICT (version) DO NOTHING`)
    })()
    schemaReady = pending.catch((error) => {
      // A transient Neon cold-start timeout must not poison schema setup for
      // the lifetime of this server process. The next API request can retry.
      schemaReady = null
      throw error
    })
  }
  return schemaReady
}

export interface QueryResultRow {
  affectedRows?: number
  insertId?: number
  [key: string]: unknown
}

/**
 * Run a parameterized query against Postgres. Accepts MySQL-style `?`
 * placeholders (converted to `$n`) and returns the pg result.rows array.
 * For compatibility with existing callers that relied on MySQL `affectedRows`
 * and `insertId`, attach those as non-enumerable properties on the array.
 */
export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  const db = getPool()
  if (!db) throw new Error('DATABASE_URL is not configured')
  await ensureSchema()
  const converted = convertPlaceholders(sql)
  const result = await (transactionContext.getStore() ?? db).query(converted, params)
  const rows = Array.isArray(result.rows) ? result.rows : []
  Object.defineProperty(rows, 'affectedRows', { value: result.rowCount ?? 0, enumerable: false })
  Object.defineProperty(rows, 'insertId', { value: (rows[0] as any)?.id ?? 0, enumerable: false })
  return rows as T
}

export async function withTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const db = getPool()
  if (!db) throw new Error('DATABASE_URL is not configured')
  await ensureSchema()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await transactionContext.run(client, operation)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function closeDatabase() {
  if (pool) await pool.end()
  pool = null
  schemaReady = null
}
