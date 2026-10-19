import { config as loadEnv } from 'dotenv'
import { closeDatabase, ensureSchema } from './db'

loadEnv()

try {
  await ensureSchema()
  console.log('StellaNova database schema is ready')
} finally {
  await closeDatabase()
}
