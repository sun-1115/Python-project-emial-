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

// Send-only, plus identity. `openid`/`userinfo.email` grant NO mailbox access —
// they only reveal WHICH account consented, which is what lets us prove that
// token-<label>.json really belongs to <label>@gmail.com. Without them the label
// is just a filename someone typed at auth time, and a token authorized while
// signed into the wrong Google account is silently mislabelled: the campaign
// then reports sends under a name that never sent them.
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

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
  //
  // Merge onto whatever is on DISK RIGHT NOW, not onto `token` — that snapshot
  // was read when this client was built and may be hours stale. A long-running
  // daemon merging its own stale copy would silently revert a re-authorization
  // done in the meantime (restoring the previous account's refresh_token) and
  // drop fields the refresh response omits, such as the id_token that records
  // which mailbox consented.
  client.on('tokens', (t) => {
    let current = token;
    try {
      if (existsSync(tokenPath)) current = JSON.parse(readFileSync(tokenPath, 'utf8'));
    } catch {
      /* unreadable/half-written — fall back to the snapshot rather than lose the refresh */
    }
    writeFileSync(tokenPath, JSON.stringify({ ...current, ...t }, null, 2));
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
 * Consent URL for the dashboard-driven (web-mediated) re-auth flow. Unlike
 * runConsentFlow (which spins its own localhost server), this hands the redirect
 * back to the already-running UI server. The SAME `redirectUri` must be passed
 * to exchangeCodeAndSave — Google validates it against the one used here. The
 * account label is carried through OAuth `state` so the callback knows which
 * token file to write.
 */
export function buildAuthUrl(label: string, redirectUri: string): string {
  const client = makeOAuthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: 'offline', // ask for a refresh_token
    prompt: 'consent', // force a fresh refresh_token even on re-auth
    scope: SCOPES,
    state: label,
  });
}

/**
 * Exchange an OAuth `code` (from the dashboard flow) for tokens and persist
 * tokens/token-<label>.json. If Google omits a refresh_token on re-consent, the
 * previous one is preserved so long-running sending keeps working. Returns
 * whether the saved token has a usable refresh_token.
 */
export async function exchangeCodeAndSave(
  label: string,
  code: string,
  redirectUri: string
): Promise<{ tokenPath: string; hasRefresh: boolean }> {
  const client = makeOAuthClient(redirectUri);
  const { tokens } = await client.getToken(code);
  const tokenPath = tokenPathFor(label);
  mkdirSync(dirname(tokenPath), { recursive: true });
  let merged = tokens;
  if (!tokens.refresh_token && existsSync(tokenPath)) {
    try {
      const prev = JSON.parse(readFileSync(tokenPath, 'utf8'));
      if (prev.refresh_token) merged = { ...tokens, refresh_token: prev.refresh_token };
    } catch {
      /* fall back to whatever Google returned */
    }
  }
  // Stamp the consenting mailbox permanently. The id_token itself is short-lived
  // and absent from every refresh response, so identity would otherwise vanish on
  // the first refresh; verified_email is our own field and survives the merge.
  const consented = emailFromIdToken(merged.id_token);
  const toWrite: Record<string, unknown> = { ...merged };
  if (consented) toWrite.verified_email = consented;
  writeFileSync(tokenPath, JSON.stringify(toWrite, null, 2));
  return { tokenPath, hasRefresh: Boolean(merged.refresh_token) };
}

const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/** Human-readable reminder for the one consent-screen mistake that causes this. */
export const MISSING_SCOPE_HINT =
  `token lacks the ${SEND_SCOPE} scope — re-authorize and TICK ` +
  `"Send email on your behalf" on Google's consent screen`;

/**
 * Was gmail.send actually granted? Google's granular permissions let someone
 * approve the sign-in scopes while leaving the Gmail checkbox unticked: the
 * account then authenticates perfectly and fails only at the moment it sends,
 * with "Request had insufficient authentication scopes".
 *
 * Returns null when the token predates scope recording — unknown, NOT missing,
 * so an old-but-working token is never retired on a guess.
 */
export function hasSendScope(tokenPath: string): boolean | null {
  if (!existsSync(tokenPath)) return null;
  try {
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
    if (typeof token.scope !== 'string' || !token.scope.trim()) return null;
    return token.scope.split(/\s+/).includes(SEND_SCOPE);
  } catch {
    return null;
  }
}

/**
 * Health-check one account's token: does it exist, carry a refresh_token, grant
 * gmail.send, and can it still obtain a fresh access token? A failed refresh
 * (invalid_grant) means the token expired (Testing-mode 7-day limit) or was
 * revoked. A refresh that succeeds without gmail.send is the more confusing
 * case — it looks healthy but cannot send a single message, so it fails here.
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
    if (!res?.token) return { ok: false, hasRefresh, expiryDate: token.expiry_date };
    if (hasSendScope(tokenPath) === false) {
      return { ok: false, hasRefresh, expiryDate: token.expiry_date, error: MISSING_SCOPE_HINT };
    }
    return { ok: true, hasRefresh, expiryDate: token.expiry_date };
  } catch (err) {
    return {
      ok: false,
      hasRefresh,
      expiryDate: token.expiry_date,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The Gmail address a token actually authenticates as — the ground truth the
 * filename only claims. Reads the `email` claim from the stored id_token; if the
 * token predates the identity scopes there is nothing to read, so it returns
 * null (meaning "unverifiable", NOT "mismatched"). Re-authorize to populate it.
 */
export function mailboxOf(tokenPath: string): string | null {
  if (!existsSync(tokenPath)) return null;
  try {
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
    // verified_email is stamped at consent and persists; id_token is the live
    // claim but only exists until the first refresh drops it.
    if (typeof token.verified_email === 'string') return token.verified_email;
    return emailFromIdToken(token.id_token);
  } catch {
    return null; // malformed token — treat as unverifiable
  }
}

/** The `email` claim inside a Google id_token (a JWT), or null. */
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string' || !idToken.includes('.')) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

/** Lowercase + strip non-alphanumerics, so "coding-ninja714" == "coding.ninja714". */
const normalizeId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Does this token's real mailbox match the label it is filed under?
 * 'ok' | 'mismatch' | 'unverified' (token issued before the identity scopes).
 */
export function checkAccountIdentity(
  label: string,
  tokenPath: string
): { status: 'ok' | 'mismatch' | 'unverified'; mailbox: string | null } {
  const mailbox = mailboxOf(tokenPath);
  if (!mailbox) return { status: 'unverified', mailbox: null };
  const local = normalizeId(mailbox.split('@')[0]);
  const want = normalizeId(label);
  // startsWith, not equality — token-khushi50211.json is legitimately the
  // mailbox khushi50211.11@gmail.com (same prefix rule the warm-up pairing uses).
  const ok = local.startsWith(want) || want.startsWith(local);
  return { status: ok ? 'ok' : 'mismatch', mailbox };
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

/** base64 for a MIME part: wrapped at 76 chars, as RFC 2045 requires. Unwrapped
 *  multi-kilobyte lines are technically non-conformant and read as sloppy to
 *  filters, even though Gmail itself accepts them. */
const base64Part = (s: string): string =>
  Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8') // MIME line endings, uniformly
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

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
          base64Part(text),
          '',
          `--${boundaryAlt}`,
          'Content-Type: text/html; charset="UTF-8"',
          'Content-Transfer-Encoding: base64',
          '',
          base64Part(opts.html),
          '',
          `--${boundaryAlt}--`,
        ].join('\r\n'),
      };
    }
    return {
      contentHeaders: ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'],
      body: base64Part(text),
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
