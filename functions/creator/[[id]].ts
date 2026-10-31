import { proxyToVercel } from '../_proxy'

export const onRequest: PagesFunction<{ VERCEL_API_ORIGIN?: string }> = (context) => proxyToVercel(context)
