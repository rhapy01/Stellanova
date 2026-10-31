import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { Resolver } from 'node:dns/promises'
import dotenv from 'dotenv'

const isWindows = process.platform === 'win32'
const run = (command, args) => {
  const executable = isWindows && ['npm', 'npx'].includes(command) ? `${command}.cmd` : command
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: isWindows,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const git = (...args) => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim() } catch { return '' }
}

const revision = git('rev-parse', '--short', 'HEAD') || 'unknown'
const dirty = Boolean(git('status', '--porcelain'))
console.log(`${process.argv.includes('--verify-only') ? 'Checking' : 'Deploying'} NovaMarket from ${revision}${dirty ? ' (working tree has uncommitted changes)' : ''}.`)

const verifyOnly = process.argv.includes('--verify-only')

if (!verifyOnly) {
  // Use Vercel's production public settings for the shared frontend build.
  run('npx', ['vercel', 'pull', '--yes', '--environment=production'])
  const productionEnvPath = '.vercel/.env.production.local'
  if (existsSync(productionEnvPath)) {
    const productionEnv = dotenv.parse(readFileSync(productionEnvPath))
    for (const [name, value] of Object.entries(productionEnv)) {
      if (name.startsWith('VITE_')) process.env[name] = value
    }
    unlinkSync(productionEnvPath)
  }

  run('npm', ['run', 'build'])

  if (!existsSync('dist/index.html')) {
    throw new Error('Production build did not produce dist/index.html.')
  }

  // Keep Vercel healthy first because Cloudflare forwards API requests to it.
  // Vercel builds the backend remotely with its production runtime and secrets.
  run('npx', ['vercel', '--prod', '--yes'])
  run('npx', ['wrangler', 'pages', 'deploy', 'dist', '--project-name', 'novamarket'])
}

const checks = [
  ['Vercel site', 'https://novamarket-xi.vercel.app/'],
  ['Cloudflare site', 'https://novamarket-a2p.pages.dev/'],
  ['Cloudflare collections API', 'https://novamarket-a2p.pages.dev/api/collections'],
  ['Cloudflare marketplace API', 'https://novamarket-a2p.pages.dev/api/marketplace/status'],
]
const publicDns = new Resolver()
publicDns.setServers(['1.1.1.1'])

for (const [label, url] of checks) {
  let lastError
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const hostname = new URL(url).hostname
      const addresses = await publicDns.resolve4(hostname)
      for (const address of addresses) {
        const result = spawnSync(isWindows ? 'curl.exe' : 'curl', [
          '-4', '-sS', '--max-time', '15', '--resolve', `${hostname}:443:${address}`,
          '-o', isWindows ? 'NUL' : '/dev/null', '-w', '%{http_code}', url,
        ], { encoding: 'utf8' })
        if (result.error) throw result.error
        const status = result.stdout.trim()
        if (result.status === 0 && /^2\d\d$/.test(status)) {
          console.log(`${label}: HTTP ${status}`)
          lastError = undefined
          break
        }
        lastError = new Error(result.stderr.trim() || `HTTP ${status || result.status}`)
      }
      if (!lastError) break
    } catch (error) {
      lastError = error
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000))
    }
  }
  if (lastError) throw new Error(`${label} failed after deployment: ${lastError.message}`)
}

console.log('Hybrid production deployment completed and passed smoke checks.')
