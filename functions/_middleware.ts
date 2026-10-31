export async function onRequest(context: { request: Request; next: () => Promise<Response> }) {
  const incoming = new URL(context.request.url)
  if (incoming.hostname === 'stellanova.pages.dev') {
    return Response.redirect(new URL(`${incoming.pathname}${incoming.search}`, 'https://novamarket-a2p.pages.dev'), 301)
  }
  return context.next()
}
