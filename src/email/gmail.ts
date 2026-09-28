// Gmail sender — OAuth 2.0 (send-only scope) with token persistence & auto-refresh,
// MIME construction (text/plain + optional text/html, Cc/Bcc, attachments), and
// users.messages.send with exponential backoff on 429 / 5xx.
//
// First-time consent: run `npm run email:auth` once to create token.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createServer } from 'node:http';
import { google } from 'googleapis';

// Derive the client type from `google` itself — importing OAuth2Client from
// google-auth-library can resolve to a duplicate copy and clash with googleapis.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/** Minimal scope: send only, no read access to the mailbox. */
export const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH?.trim() || './credentials.json';
const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH?.trim() || './token.json';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ClientSecret {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

/** Read OAuth client creds from env vars first, else from credentials.json. */
function loadClientSecret(): ClientSecret {
  const envId = process.env.GOOGLE_CLIENT_ID?.trim();
  const envSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { client_id: envId, client_secret: envSecret };
  }
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `No Gmail credentials found. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, ` +
        `or place an OAuth client file at ${CREDENTIALS_PATH}.`
    );
  }
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
  // Desktop/Web OAuth client files nest creds under "installed" or "web".
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) {
    throw new Error(`${CREDENTIALS_PATH} is missing client_id / client_secret.`);
  }
  return { client_id: c.client_id, client_secret: c.client_secret, redirect_uris: c.redirect_uris };
}

function makeOAuthClient(redirectUri: string): OAuth2Client {
  const { client_id, client_secret } = loadClientSecret();
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

/**
 * Build an authorized client from a saved token file, refreshing (and
 * re-persisting) automatically when the access token expires. Throws with a
 * clear message if no token exists yet.
 *
 * Pass a per-account token path to drive one of many accounts; defaults to the
 * single-account TOKEN_PATH for backward compatibility.
 */
export function getAuthorizedClient(tokenPath: string = TOKEN_PATH): OAuth2Client {
  if (!existsSync(tokenPath)) {
    throw new Error(
      `No ${tokenPath}. Run the one-time consent flow first: npm run email:auth -- --account <label>`
    );
  }
  const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
  const client = makeOAuthClient('http://localhost'); // redirect unused once we have a token
  client.setCredentials(token);
  // Persist refreshed tokens back to THIS account's file (googleapis emits this
  // event whenever it auto-refreshes the access token).
  client.on('tokens', (t) => {
    const merged = { ...token, ...t };
    writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
  });
  return client;
}

/** Where a given account's token file lives (./tokens/token-<label>.json). */
export function tokenPathFor(label: string): string {
  const dir = process.env.EMAIL_TOKENS_DIR?.trim() || './tokens';
  return `${dir}/token-${label}.json`;
}

/**
 * Interactive first-time consent for ONE account. Spins a localhost server to
 * catch the OAuth redirect, opens no browser itself — prints the URL for you to
 * visit — then writes tokens/token-<label>.json. Run once per account via
 * `npm run email:auth -- --account <label>`.
 */
export async function runConsentFlow(label = 'default', port = 5555): Promise<void> {
  const tokenPath = tokenPathFor(label);
  const redirectUri = `http://localhost:${port}/oauth2callback`;
  const client = makeOAuthClient(redirectUri);
  const authUrl = client.generateAuthUrl({
    access_type: 'offline', // ask for a refresh_token
    prompt: 'consent', // force refresh_token even on re-auth
    scope: SCOPES,
  });

  console.log(`\nAuthorizing account "${label}" → ${tokenPath}`);
  console.log('\n1. Open this URL in your browser and approve access:\n');
  console.log('   ' + authUrl + '\n');
  console.log(`2. Waiting for Google to redirect back to ${redirectUri} ...\n`);

  const code: string = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '', redirectUri);
        const c = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        if (err) {
          res.end(`Auth failed: ${err}. You can close this tab.`);
          server.close();
          return reject(new Error(`OAuth error: ${err}`));
        }
        if (c) {
          res.end('Authorized! You can close this tab and return to the terminal.');
          server.close();
          resolve(c);
        }
      } catch (e) {
        reject(e);
      }
    });
    server.listen(port);
    server.on('error', reject);
  });

  const { tokens } = await client.getToken(code);
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  if (!tokens.refresh_token) {
    console.warn(
      `\n⚠  No refresh_token returned for "${label}". Revoke the app's access at ` +
        `https://myaccount.google.com/permissions and re-run — a refresh token is ` +
        `required for long-running sending.`
    );
  }
  console.log(`\nSaved ${tokenPath}. Account "${label}" is ready to send.\n`);
}

/**
 * Health-check one account's token: does it exist, carry a refresh_token, and
 * can it still obtain a fresh access token? A failed refresh (invalid_grant)
 * means the token expired (Testing-mode 7-day limit) or was revoked.
 */
export async function verifyToken(
  tokenPath: string
): Promise<{ ok: boolean; hasRefresh: boolean; expiryDate?: number; error?: string }> {
  if (!existsSync(tokenPath)) return { ok: false, hasRefresh: false, error: 'token file missing' };
  const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
  const hasRefresh = Boolean(token.refresh_token);
  try {
    const client = getAuthorizedClient(tokenPath);
    const res = await client.getAccessToken(); // refreshes if the access token is stale
    return { ok: Boolean(res?.token), hasRefresh, expiryDate: token.expiry_date };
  } catch (err) {
    return {
      ok: false,
      hasRefresh,
      expiryDate: token.expiry_date,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface Attachment {
  filename: string;
  content: Buffer | string; // raw bytes (Buffer) or utf8 string
  contentType?: string; // defaults to application/octet-stream
}

export interface SendEmailOptions {
  from?: string; // defaults to the authenticated user ("me")
  cc?: string | string[];
  bcc?: string | string[];
  html?: string; // if set, message is sent as multipart/alternative (text + html)
  attachments?: Attachment[];
  auth?: OAuth2Client; // reuse one client across many sends (campaign)
}

export interface SendResult {
  id: string;
  threadId: string;
}

const asList = (v?: string | string[]) => (Array.isArray(v) ? v.join(', ') : v);

/** RFC 2047 encode a header value so non-ASCII subjects/names survive. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** URL-safe base64 with padding stripped, as Gmail's raw field requires. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Assemble a raw MIME message (base64url string) for users.messages.send. */
export function buildRawMessage(
  to: string,
  subject: string,
  text: string,
  opts: SendEmailOptions = {}
): string {
  const boundaryMixed = 'mixed_' + Buffer.from(subject + to).toString('hex').slice(0, 16);
  const boundaryAlt = 'alt_' + Buffer.from(to + subject).toString('hex').slice(0, 16);
  const headers: string[] = [];
  if (opts.from) headers.push(`From: ${opts.from}`);
  headers.push(`To: ${to}`);
  if (opts.cc) headers.push(`Cc: ${asList(opts.cc)}`);
  if (opts.bcc) headers.push(`Bcc: ${asList(opts.bcc)}`);
  headers.push(`Subject: ${encodeHeader(subject)}`);
  headers.push('MIME-Version: 1.0');

  const parts: string[] = [];
  const hasAttach = (opts.attachments?.length ?? 0) > 0;

  // Body content headers (Content-Type / Content-Transfer-Encoding) and the body
  // proper. These headers belong with whatever MIME part they describe — the
  // top-level message headers for a single-part message, or after a
  // `--boundary` line when wrapped in multipart/mixed. Keeping them separate lets
  // the caller place them correctly; emitting them into the body (below the
  // header/body separator) makes clients render them as literal text.
  const bodySection = (): { contentHeaders: string[]; body: string } => {
    if (opts.html) {
      return {
        contentHeaders: [`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`],
        body: [
          `--${boundaryAlt}`,
          'Content-Type: text/plain; charset="UTF-8"',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(text, 'utf8').toString('base64'),
          '',
          `--${boundaryAlt}`,
          'Content-Type: text/html; charset="UTF-8"',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(opts.html, 'utf8').toString('base64'),
          '',
          `--${boundaryAlt}--`,
        ].join('\r\n'),
      };
    }
    return {
      contentHeaders: ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'],
      body: Buffer.from(text, 'utf8').toString('base64'),
    };
  };

  if (!hasAttach) {
    // Single part: promote the body's content headers to the top-level headers so
    // there's exactly one header block, then a blank line, then the encoded body.
    const { contentHeaders, body } = bodySection();
    headers.push(...contentHeaders);
    parts.push(headers.join('\r\n'));
    parts.push(''); // blank line between headers and body
    parts.push(body);
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`);
    parts.push(headers.join('\r\n'));
    parts.push('');
    parts.push(`--${boundaryMixed}`);
    const { contentHeaders, body } = bodySection();
    parts.push(contentHeaders.join('\r\n'));
    parts.push(''); // blank line between the part's headers and its body
    parts.push(body);
    for (const att of opts.attachments!) {
      const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content, 'utf8');
      parts.push('');
      parts.push(`--${boundaryMixed}`);
      parts.push(`Content-Type: ${att.contentType ?? 'application/octet-stream'}; name="${basename(att.filename)}"`);
      parts.push('Content-Transfer-Encoding: base64');
      parts.push(`Content-Disposition: attachment; filename="${basename(att.filename)}"`);
      parts.push('');
      parts.push(buf.toString('base64').replace(/(.{76})/g, '$1\r\n'));
    }
    parts.push('');
    parts.push(`--${boundaryMixed}--`);
  }

  return base64url(Buffer.from(parts.join('\r\n'), 'utf8'));
}

function isRetryable(err: unknown): boolean {
  const e = err as { code?: number; status?: number; response?: { status?: number } };
  const status = e?.code ?? e?.status ?? e?.response?.status;
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

/** Pull the clearest message out of a googleapis error. */
function describeError(err: unknown): string {
  const e = err as {
    message?: string;
    errors?: { message?: string }[];
    response?: { data?: { error?: { message?: string } } };
  };
  return (
    e?.response?.data?.error?.message ??
    e?.errors?.[0]?.message ??
    e?.message ??
    String(err)
  );
}

/**
 * Send one email. Clean signature: sendEmail(to, subject, body, opts).
 * Retries 429/5xx with exponential backoff; surfaces Gmail's error message.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  opts: SendEmailOptions = {},
  maxRetries = 4
): Promise<SendResult> {
  const auth = opts.auth ?? getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage(to, subject, body, opts);

  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      return { id: res.data.id ?? '', threadId: res.data.threadId ?? '' };
    } catch (err) {
      if (isRetryable(err) && attempt <= maxRetries) {
        console.warn(`[gmail] ${describeError(err)} — retry ${attempt}/${maxRetries} in ${delay}ms`);
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw new Error(`Gmail send to ${to} failed: ${describeError(err)}`);
    }
  }
}
