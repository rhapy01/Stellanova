import { config as loadEnv } from 'dotenv'
import { closeDatabase, ensureSchema } from './db'

loadEnv()

try {
  await ensureSchema()
  console.log('NovaMarket database schema is ready')
} finally {
  await closeDatabase()
}
