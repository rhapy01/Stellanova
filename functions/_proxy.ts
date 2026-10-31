interface ProxyEnv {
  VERCEL_API_ORIGIN?: string
}

export async function proxyToVercel(context: { request: Request; env: ProxyEnv }): Promise<Response> {
  const incomingUrl = new URL(context.request.url)
  const origin = (context.env.VERCEL_API_ORIGIN || 'https://novamarket-xi.vercel.app').replace(/\/+$/, '')
  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, origin)
  const upstreamRequest = new Request(targetUrl, context.request)
  upstreamRequest.headers.set('x-forwarded-host', incomingUrl.host)
  upstreamRequest.headers.set('x-forwarded-proto', incomingUrl.protocol.slice(0, -1))

  const response = await fetch(upstreamRequest)
  const contentType = response.headers.get('content-type') || ''
  if (!/(?:text\/|application\/(?:json|xml|javascript))/.test(contentType)) return response

  const body = (await response.text())
    .replaceAll('https://novamarket-a2p.pages.dev', incomingUrl.origin)
    .replaceAll('https://stellanova.pages.dev', incomingUrl.origin)
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.delete('etag')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
