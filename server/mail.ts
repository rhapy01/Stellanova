import { config as loadEnv } from 'dotenv'
import nodemailer from 'nodemailer'

// This module computes SMTP availability during import. Load .env here because
// ES module dependencies are evaluated before server/index.ts reaches its own
// dotenv call.
loadEnv()

/**
 * Email delivery via Google SMTP (nodemailer).
 *
 * Configure with:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_SECURE=true            (465/TLS) — use false for 587/STARTTLS
 *   SMTP_USER=you@gmail.com
 *   SMTP_PASS=<Google App Password>
 *   MAIL_FROM="StellaNova <you@gmail.com>"
 *
 * For Gmail use a Google App Password (16 chars) with 2-Step Verification
 * enabled — not your normal account password.
 */

const smtpEnabled = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)

const transporter = smtpEnabled
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST!,
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: String(process.env.SMTP_SECURE ?? 'true') !== 'false',
      auth: {
        user: process.env.SMTP_USER!,
        pass: process.env.SMTP_PASS!,
      },
    })
  : null

export function mailConfigured(): boolean {
  return smtpEnabled && transporter !== null
}

export async function sendMail(input: {
  to: string
  subject: string
  text: string
  html?: string
}): Promise<{ sent: boolean; error?: string }> {
  if (!transporter) {
    return { sent: false, error: 'SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)' }
  }
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM ?? process.env.SMTP_USER ?? 'StellaNova',
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html ?? input.text.replace(/\n/g, '<br/>'),
    })
    return { sent: true }
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : 'Email could not be sent' }
  }
}

export type EmailPreviewExample = { category: string; subject: string; body: string; actionUrl?: string; actionLabel?: string }

function escapeEmailHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function emailParagraphs(body: string) {
  return body.split(/\n\s*\n/).filter(Boolean).map((paragraph) => `<p style="margin:0 0 16px;color:#4b4654;font-size:15px;line-height:1.65;">${escapeEmailHtml(paragraph).replace(/\n/g, '<br/>')}</p>`).join('')
}

function emailCard(subject: string, body: string, actionUrl: string, actionLabel: string, category = 'MARKETPLACE UPDATE') {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e9e5ef;border-radius:18px;overflow:hidden;">
    <tr><td style="height:6px;background:linear-gradient(100deg,#5752ef 0%,#bd35a5 50%,#ff4c42 78%,#ffa83d 100%);"></td></tr>
    <tr><td style="padding:25px 30px 18px;border-bottom:1px solid #f0edf3;"><div style="font-size:21px;font-weight:700;letter-spacing:-.5px;color:#211d29;">StellaNova</div><div style="margin-top:5px;font-size:11px;letter-spacing:1.5px;font-weight:700;color:#85808d;">${escapeEmailHtml(category)}</div></td></tr>
    <tr><td style="padding:30px;"><h1 style="margin:0 0 18px;font-size:24px;line-height:1.25;letter-spacing:-.4px;color:#211d29;">${escapeEmailHtml(subject)}</h1>${emailParagraphs(body)}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;"><tr><td align="center" style="border-radius:10px;background:#6551e8;"><a href="${escapeEmailHtml(actionUrl)}" style="display:inline-block;padding:13px 22px;color:#fff;text-decoration:none;font-size:14px;font-weight:700;">${escapeEmailHtml(actionLabel)}</a></td></tr></table>
    </td></tr>
    <tr><td style="padding:18px 30px 23px;border-top:1px solid #f0edf3;color:#898491;font-size:12px;line-height:1.55;">This update is linked to marketplace activity for your StellaNova wallet.<br><span style="color:#aaa5b0;">StellaNova · Stellar Testnet</span></td></tr>
  </table>`
}

export function marketplaceEmail(subject: string, body: string, actionUrl?: string, actionLabel = 'View marketplace activity') {
  const safeUrl = actionUrl && /^https:\/\//i.test(actionUrl) ? actionUrl : 'https://stellanova-fawn.vercel.app/'
  const text = `${body}\n\n${actionUrl ? `Open on StellaNova: ${actionUrl}` : 'Open StellaNova to review marketplace activity.'}`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;background:#f5f3f8;font-family:Arial,Helvetica,sans-serif;color:#211d29;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeEmailHtml(subject)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f8;padding:36px 14px;"><tr><td align="center">${emailCard(subject, body, safeUrl, actionLabel)}</td></tr></table></body></html>`
  return { text, html }
}

export function emailTemplateGallery(examples: EmailPreviewExample[]) {
  const text = examples.map((example) => `${example.category} — ${example.subject}\n${example.body}\n${example.actionUrl ?? 'https://stellanova-fawn.vercel.app/'}\n`).join('\n')
  const cards = examples.map((example) => `<tr><td style="padding:12px 14px;">${emailCard(example.subject, example.body, example.actionUrl && /^https:\/\//i.test(example.actionUrl) ? example.actionUrl : 'https://stellanova-fawn.vercel.app/', example.actionLabel ?? 'Open StellaNova', example.category)}</td></tr>`).join('')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;background:#f5f3f8;font-family:Arial,Helvetica,sans-serif;color:#211d29;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f8;padding:24px 8px;"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;"><tr><td style="padding:16px 14px 24px;"><div style="font-size:22px;font-weight:700;color:#211d29;">StellaNova email previews</div><p style="margin:8px 0 0;color:#686270;font-size:14px;line-height:1.5;">Examples of current account and marketplace email notifications.</p></td></tr>${cards}</table></td></tr></table></body></html>`
  return { text, html }
}

/**
 * A friendly welcome message for the email sign-up flow. Tells the user their
 * non-custodial Stellar wallet is ready.
 */
export function welcomeEmail(to: string, walletAddress: string): { subject: string; text: string; html: string } {
  const shortened = walletAddress.length > 12 ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : walletAddress
  const safeWallet = escapeEmailHtml(walletAddress)
  const safeShortWallet = escapeEmailHtml(shortened)
  const appUrl = process.env.PUBLIC_APP_URL ?? process.env.APP_URL ?? 'https://stellanova-fawn.vercel.app'
  const safeAppUrl = /^https:\/\//i.test(appUrl) ? escapeEmailHtml(appUrl) : 'https://stellanova-fawn.vercel.app'
  const subject = 'Welcome to StellaNova — your next favorite starts here'
  const text = [
    `Hi there,`,
    ``,
    `Thanks for signing up to StellaNova. Your non-custodial Stellar wallet is now ready.`,
    ``,
    `Your wallet address: ${walletAddress} (${shortened})`,
    ``,
    `Your StellaNova wallet is ready. Discover artwork, collect NFTs, follow creators, or make something of your own.`,
    ``,
    `Happy collecting,`,
    `The StellaNova team`,
  ].join('\n')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
  <body style="margin:0;padding:0;background:#f4f1fa;font-family:Arial,Helvetica,sans-serif;color:#f9f6ff;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your creative space on Stellar is ready to explore.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1fa;padding:36px 14px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#11101d;border-radius:24px;overflow:hidden;border:1px solid #28233a;">
          <tr><td style="height:7px;background:linear-gradient(100deg,#6256ff 0%,#bb39ce 48%,#ff536b 76%,#ffb342 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td style="padding:28px 34px 14px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:20px;font-weight:700;letter-spacing:-.5px;color:#fff;">✦ StellaNova</td><td align="right" style="font-size:10px;font-weight:700;letter-spacing:1.8px;color:#b6aecb;">YOUR ONCHAIN GALLERY</td></tr></table>
          </td></tr>
          <tr><td style="padding:22px 34px 30px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1c1930;border:1px solid #37304f;border-radius:18px;"><tr><td style="padding:26px 26px 28px;">
              <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#b8a9ff;">A NEW SPACE FOR ART</div>
              <h1 style="margin:12px 0 12px;font-size:34px;line-height:1.08;letter-spacing:-1.2px;color:#fff;">Welcome to<br><span style="color:#d6aaff;">StellaNova.</span></h1>
              <p style="margin:0;color:#d2cddd;font-size:15px;line-height:1.7;">Your gallery is open. Find work that moves you, meet the creators behind it, and bring the pieces you love into your collection.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;"><tr><td style="border-radius:11px;background:#7957ef;"><a href="${safeAppUrl}" style="display:inline-block;padding:14px 22px;color:#fff;text-decoration:none;font-size:14px;font-weight:700;">Explore StellaNova&nbsp; ↗</a></td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding:0 34px 26px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:1.7px;color:#9e96b4;">YOUR FIRST THREE STOPS</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:13px;"><tr>
              <td width="33%" valign="top" style="padding:13px 9px;background:#1a1728;border:1px solid #302b40;border-radius:12px;"><div style="font-size:19px;">◉</div><div style="margin-top:8px;color:#fff;font-size:13px;font-weight:700;">Discover</div><div style="margin-top:4px;color:#aaa3b8;font-size:11px;line-height:1.45;">Explore art and collections</div></td>
              <td width="8"></td>
              <td width="33%" valign="top" style="padding:13px 9px;background:#1a1728;border:1px solid #302b40;border-radius:12px;"><div style="font-size:19px;">◇</div><div style="margin-top:8px;color:#fff;font-size:13px;font-weight:700;">Collect</div><div style="margin-top:4px;color:#aaa3b8;font-size:11px;line-height:1.45;">Keep the work you love</div></td>
              <td width="8"></td>
              <td width="33%" valign="top" style="padding:13px 9px;background:#1a1728;border:1px solid #302b40;border-radius:12px;"><div style="font-size:19px;">✳</div><div style="margin-top:8px;color:#fff;font-size:13px;font-weight:700;">Create</div><div style="margin-top:4px;color:#aaa3b8;font-size:11px;line-height:1.45;">Bring your own vision</div></td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:0 34px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#171522;border:1px solid #302b40;border-radius:12px;"><tr><td style="padding:15px 17px;"><div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#9e96b4;">YOUR STELLAR WALLET</div><div style="margin-top:8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#eee9f7;">${safeShortWallet}</div><div style="margin-top:4px;word-break:break-all;font-size:10px;line-height:1.5;color:#898398;">${safeWallet}</div></td></tr></table>
          </td></tr>
          <tr><td style="padding:20px 34px 25px;border-top:1px solid #302b40;color:#a29bb0;font-size:12px;line-height:1.6;">Sign in with your email whenever you return. Your wallet is linked to your account; StellaNova never asks you to share a seed phrase.<br><br><span style="color:#d2cddd;">Make room for wonder.</span><br>StellaNova · Stellar Testnet</td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`
  return { subject, text, html }
}
