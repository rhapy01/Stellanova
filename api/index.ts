import type { IncomingMessage, ServerResponse } from 'node:http'
import app from '../server/index.js'

/** Route every `/api/*` request through the shared Express application. */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  const incoming = new URL(req.url ?? '/', 'https://novamarket.invalid')
  const route = incoming.searchParams.get('__route')

  if (route) {
    incoming.searchParams.delete('__route')
    const query = incoming.searchParams.toString()
    req.url = `/api/${route.replace(/^\/+/, '')}${query ? `?${query}` : ''}`
  }

  return app(req, res)
}
