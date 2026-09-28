import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { UserStore, SORT_SQL, type SortKey } from './db.js';
import { discoverAccounts } from './email/accounts.js';
import {
  buildAuthUrl,
  exchangeCodeAndSave,
  verifyToken,
  tokenPathFor,
  getAuthorizedClient,
  sendEmail,
} from './email/gmail.js';
import {
  inSendWindow,
  inCatchupHours,
  zonedDateString,
  effectiveDailyCap,
  TIMEZONE,
  SEND_START_HOUR,
  SEND_END_HOUR,
  CATCHUP_END_HOUR,
  CATCHUP_ENABLED,
} from './email/pacing.js';
import { runCampaign } from './email/campaign.js';
import { loadTemplates, parseTemplate, type Template } from './email/content.js';
import { runWarmupRound, warmupPeers, warmupAddresses } from './email/warmup.js';

const config = loadConfig();
const store = new UserStore(config.dbPath);
const app = express();

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

// --- Embedded campaign controller (Start/Stop from the dashboard) ---
// The send loop runs inside this server process so the UI can control it. Its
// desired state ('on'/'off') is persisted in crawl_state, so if the server is
// restarted (e.g. by pm2) it resumes whatever the user last chose.
const MESSAGES_DIR = process.env.EMAIL_MESSAGES_DIR?.trim() || './messages';
const DEFAULT_SUBJECT = process.env.EMAIL_SUBJECT?.trim() || 'Hi {{name|there}}';
const DEFAULT_BODY =
  'Hi {{name|there}},\n\n' +
  "{I came across|I stumbled on|I ran into} your GitHub profile (@{{login}}) and wanted to reach out.\n\n" +
  '{Best regards|Thanks|Cheers}.';

const campaign = {
  running: false,
  stopFlag: false,
  lastError: null as string | null,
  startedAt: null as string | null,
};

/** The origin messages (messages/01–06), or the built-in default if none.
 *  Read fresh on each use so edits to the folder take effect without a restart. */
function campaignTemplates(): Template[] {
  const templates = loadTemplates(MESSAGES_DIR);
  return templates.length > 0 ? templates : [parseTemplate('default', DEFAULT_BODY)];
}

function startCampaign(): void {
  if (campaign.running) return;
  const templates = campaignTemplates();

  campaign.running = true;
  campaign.stopFlag = false;
  campaign.lastError = null;
  campaign.startedAt = new Date().toISOString();
  store.setState('email_sending', 'on');

  runCampaign(store, {
    templates,
    defaultSubject: DEFAULT_SUBJECT,
    isStopped: () => campaign.stopFlag,
  })
    .catch((err: unknown) => {
      campaign.lastError = err instanceof Error ? err.message : String(err);
      console.error('[campaign] stopped on error:', campaign.lastError);
    })
    .finally(() => {
      campaign.running = false;
      campaign.startedAt = null;
    });
  console.log('[campaign] started from UI');
}

function stopCampaign(): void {
  campaign.stopFlag = true;
  store.setState('email_sending', 'off');
  console.log('[campaign] stop requested from UI');
}

// --- Warm-up scheduler (accounts email each other once a day) ---
// Runs entirely inside this server process. Once per day, during the send
// window, it fires one rotation round so every account sends one message and
// receives one. Offset advances daily so partners vary. State lives in
// crawl_state. Enabled whenever EMAIL_WARMUP_ADDRESSES lists ≥2 addresses
// (set EMAIL_WARMUP_ENABLED=false to turn it off).
const WARMUP_ENABLED = process.env.EMAIL_WARMUP_ENABLED !== 'false' && warmupAddresses().length >= 2;
let warmupRunning = false;

async function warmupTick(): Promise<void> {
  if (!WARMUP_ENABLED || warmupRunning) return;
  if (!inSendWindow()) return; // do the daily round during business hours
  const today = zonedDateString();
  if (store.getState('warmup_last_day') === today) return; // already ran today
  warmupRunning = true;
  try {
    const offset = Number(store.getState('warmup_offset') || '1') || 1;
    const res = await runWarmupRound(offset, {
      templates: campaignTemplates(),
      defaultSubject: DEFAULT_SUBJECT,
    });
    if (res.total > 0) {
      // Mark done for today (even if some sends failed) so it doesn't churn, and
      // advance the offset so tomorrow pairs different accounts.
      store.setState('warmup_last_day', today);
      const next = res.total > 1 ? (offset % (res.total - 1)) + 1 : 1;
      store.setState('warmup_offset', String(next));
    }
  } catch (err) {
    console.error('[warmup] round error:', err instanceof Error ? err.message : err);
  } finally {
    warmupRunning = false;
  }
}
if (WARMUP_ENABLED) {
  setInterval(warmupTick, 15 * 60_000); // check every 15 min; runs at most once/day
  setTimeout(warmupTick, 20_000); // and shortly after boot, in case we're mid-window
}

// --- Token health (surface expired/invalid Gmail tokens in the dashboard) ---
// verifyToken makes a network call (it forces a refresh), so results are cached
// per account and only re-checked every TOKEN_STATUS_TTL_MS. The overview poll
// reads the cache; a re-auth or explicit re-check forces a refresh.
interface TokenStatus {
  ok: boolean;
  hasRefresh: boolean;
  expiryDate?: number;
  error?: string;
  checkedAt: number;
}
const TOKEN_STATUS_TTL_MS = 10 * 60 * 1000;
const tokenStatusCache = new Map<string, TokenStatus>();

async function getTokenStatus(label: string, tokenPath: string, force = false): Promise<TokenStatus> {
  const cached = tokenStatusCache.get(label);
  if (!force && cached && Date.now() - cached.checkedAt < TOKEN_STATUS_TTL_MS) return cached;
  const v = await verifyToken(tokenPath);
  const status: TokenStatus = { ...v, checkedAt: Date.now() };
  tokenStatusCache.set(label, status);
  if (!v.ok) {
    console.warn(`[token] account "${label}" needs re-authorization: ${v.error ?? 'token invalid'}`);
  }
  return status;
}

// token-<label>.json is derived from the label, so only allow safe characters
// (no path separators / traversal).
const LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const safeLabel = (s: unknown): string | null =>
  typeof s === 'string' && LABEL_RE.test(s) ? s : null;

// Reconstruct the loopback redirect URI from the incoming request so the auth
// URL and the token exchange agree on it (Google validates they match).
const callbackUri = (req: express.Request): string =>
  `${req.protocol}://${req.get('host')}/oauth2callback`;

app.use(express.json());
app.use(express.static(publicDir));

// Page-numbered users API: ?page=1&pageSize=24&q=&sort=username|followers
app.get('/api/users', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const requested = String(req.query.sort ?? '');
  const sort: SortKey = requested in SORT_SQL ? (requested as SortKey) : 'username';
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 24;

  res.json(store.page({ q, sort, page, pageSize }));
});

app.get('/api/stats', (_req, res) => {
  res.json({ total: store.count() });
});

// Email dashboard: window status, global totals, per-account caps/usage, recent sends.
app.get('/api/email/overview', async (_req, res) => {
  const day = zonedDateString();
  const totals = store.emailTotals();
  const aggregates = store.accountAggregates();

  const accounts = await Promise.all(
    discoverAccounts().map(async (a) => {
      const registered = store.listEmailAccounts().some((r) => r.account === a.label);
      if (!registered) store.registerAccount(a.label); // surface auth'd-but-never-run accounts
      const ageDays = store.accountAgeDays(a.label);
      const paused = store.isAccountPaused(a.label);
      const cap = paused ? 0 : effectiveDailyCap(ageDays, a.label, day);
      const sentToday = store.sentCountOnDay(a.label, day);
      const agg = aggregates[a.label] ?? { totalSent: 0, lastSent: null };
      const t = await getTokenStatus(a.label, a.tokenPath);
      return {
        label: a.label,
        ageDays,
        paused,
        cap,
        sentToday,
        remaining: Math.max(cap - sentToday, 0),
        totalSent: agg.totalSent,
        lastSent: agg.lastSent,
        token: { ok: t.ok, hasRefresh: t.hasRefresh, error: t.error ?? null, checkedAt: t.checkedAt },
      };
    })
  );
  const tokensBad = accounts.filter((a) => !a.token.ok).length;

  const sentToday = accounts.reduce((n, a) => n + a.sentToday, 0);
  const capacityToday = accounts.reduce((n, a) => n + a.remaining, 0);

  res.json({
    window: {
      open: inSendWindow(),
      timezone: TIMEZONE,
      startHour: SEND_START_HOUR,
      endHour: SEND_END_HOUR,
      catchup: inCatchupHours(), // sending past the window to finish the day
      catchupEnabled: CATCHUP_ENABLED,
      catchupEndHour: CATCHUP_END_HOUR,
      day,
    },
    campaign: {
      running: campaign.running,
      desired: store.getState('email_sending') ?? 'off',
      startedAt: campaign.startedAt,
      lastError: campaign.lastError,
    },
    totals: { ...totals, sentToday, capacityToday, suppressed: store.suppressionCount() },
    accounts,
    tokensBad,
    warmup: {
      enabled: WARMUP_ENABLED,
      peers: warmupPeers().length,
      ranToday: store.getState('warmup_last_day') === day,
      lastDay: store.getState('warmup_last_day') ?? null,
      nextOffset: Number(store.getState('warmup_offset') || '1') || 1,
    },
    recent: store.recentSends(25),
  });
});

// Start / stop the embedded send loop from the dashboard.
app.post('/api/email/campaign/start', (_req, res) => {
  startCampaign();
  res.json({ running: campaign.running });
});

app.post('/api/email/campaign/stop', (_req, res) => {
  stopCampaign();
  res.json({ running: campaign.running, stopping: true });
});

// Suppression list (do-not-email): list, add (one or many), remove.
app.get('/api/email/suppressions', (_req, res) => {
  res.json({ count: store.suppressionCount(), items: store.listSuppressions(200) });
});

app.post('/api/email/suppressions', (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual';
  // Accept a single "email" or an "emails" array / newline-or-comma-separated string.
  const raw = req.body?.emails ?? req.body?.email ?? '';
  const list = (Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/))
    .map((s) => String(s).trim())
    .filter((s) => s.includes('@'));
  if (list.length === 0) return res.status(400).json({ error: 'No valid email addresses provided.' });
  const added = store.addSuppressions(list, reason);
  res.json({ added, submitted: list.length, count: store.suppressionCount() });
});

app.delete('/api/email/suppressions/:email', (req, res) => {
  const removed = store.removeSuppression(req.params.email);
  res.json({ removed, count: store.suppressionCount() });
});

// Pause / resume a sending account.
app.post('/api/email/accounts/:label/pause', (req, res) => {
  const label = req.params.label;
  const paused = Boolean(req.body?.paused);
  if (!store.listEmailAccounts().some((r) => r.account === label)) {
    return res.status(404).json({ error: `Unknown account: ${label}` });
  }
  store.setAccountPaused(label, paused);
  res.json({ label, paused });
});

// --- Gmail token management (re-authorize from the dashboard) ---

// Force a fresh token health-check for one account (bypasses the cache).
app.post('/api/email/accounts/:label/verify', async (req, res) => {
  const label = safeLabel(req.params.label);
  if (!label) return res.status(400).json({ error: 'Invalid account label.' });
  const t = await getTokenStatus(label, tokenPathFor(label), true);
  res.json({ label, ok: t.ok, hasRefresh: t.hasRefresh, error: t.error ?? null, checkedAt: t.checkedAt });
});

// Send a one-off test email from an account to confirm it can actually send
// (useful right after re-authorizing). Not logged to sent_emails / stats.
app.post('/api/email/accounts/:label/test', async (req, res) => {
  const label = safeLabel(req.params.label);
  if (!label) return res.status(400).json({ error: 'Invalid account label.' });
  const to = String(req.body?.to ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Provide a valid recipient email in "to".' });
  }
  try {
    const auth = getAuthorizedClient(tokenPathFor(label));
    const subject = `Test email from ${label} — Github Track`;
    const body =
      `This is a test message confirming the "${label}" Gmail account can send.\n\n` +
      `Sent at ${new Date().toISOString()}.`;
    const result = await sendEmail(to, subject, body, { auth });
    await getTokenStatus(label, tokenPathFor(label), true); // a successful send proves the token is good
    res.json({ ok: true, to, messageId: result.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[token] test send from "${label}" failed: ${msg}`);
    res.status(502).json({ ok: false, error: msg });
  }
});

// Begin (re)authorization: returns the Google consent URL to open in a browser.
// Works for an existing account (re-auth) or a brand-new label (add account).
app.get('/api/email/accounts/:label/auth-url', (req, res) => {
  const label = safeLabel(req.params.label);
  if (!label) return res.status(400).json({ error: 'Invalid account label. Use letters, digits, . _ - (max 64).' });
  try {
    const url = buildAuthUrl(label, callbackUri(req));
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// OAuth redirect target. Google sends the user here with ?code & ?state=<label>;
// we exchange the code, persist tokens/token-<label>.json, and show a result page.
app.get('/oauth2callback', async (req, res) => {
  const label = safeLabel(req.query.state);
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const oauthErr = typeof req.query.error === 'string' ? req.query.error : null;
  const page = (title: string, body: string, color: string) => `<!doctype html><meta charset="utf-8">
    <title>${title}</title>
    <body style="font:15px system-ui,sans-serif;background:#0b0e14;color:#e7ecf3;display:grid;place-items:center;height:100vh;margin:0">
      <div style="max-width:420px;text-align:center;padding:28px;border:1px solid #232a3b;border-radius:14px;background:#151a26">
        <div style="font-size:22px;font-weight:800;color:${color};margin-bottom:8px">${title}</div>
        <p style="color:#8b95a7">${body}</p>
        <a href="/email.html" style="display:inline-block;margin-top:10px;color:#6ea8fe;font-weight:700">← Back to dashboard</a>
      </div>
      <script>setTimeout(()=>{try{window.close()}catch(e){}},4000)</script>
    </body>`;
  if (oauthErr) return res.status(400).send(page('Authorization failed', `Google returned: ${oauthErr}. You can close this tab and try again.`, '#ff8f9c'));
  if (!label || !code) return res.status(400).send(page('Authorization failed', 'Missing authorization code or account label.', '#ff8f9c'));
  try {
    const { hasRefresh } = await exchangeCodeAndSave(label, code, callbackUri(req));
    store.registerAccount(label);
    await getTokenStatus(label, tokenPathFor(label), true); // refresh cached status now
    const warn = hasRefresh
      ? ''
      : ' <b style="color:#ffd6a5">No refresh token was returned</b> — revoke access at myaccount.google.com/permissions and re-authorize so long-running sending keeps working.';
    res.send(page('Account authorized ✓', `“${label}” is ready to send.${warn}`, '#9be59b'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).send(page('Authorization failed', `Could not save the token: ${msg}`, '#ff8f9c'));
  }
});

app.listen(config.uiPort, () => {
  console.log(`UI running at http://localhost:${config.uiPort}`);
  // Resume sending if it was left "on" (survives pm2/host restarts).
  if ((store.getState('email_sending') ?? 'off') === 'on') {
    console.log('[campaign] resuming (was on before restart)');
    startCampaign();
  }
});
