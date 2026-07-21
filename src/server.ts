import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { UserStore, SORT_SQL, type SortKey } from './db.js';
import { discoverAccounts } from './email/accounts.js';
import {
  inSendWindow,
  zonedDateString,
  effectiveDailyCap,
  TIMEZONE,
  SEND_START_HOUR,
  SEND_END_HOUR,
} from './email/pacing.js';
import { runCampaign } from './email/campaign.js';
import { loadTemplates, parseTemplate } from './email/content.js';

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

function startCampaign(): void {
  if (campaign.running) return;
  let templates = loadTemplates(MESSAGES_DIR);
  if (templates.length === 0) templates = [parseTemplate('default', DEFAULT_BODY)];

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
app.get('/api/email/overview', (_req, res) => {
  const day = zonedDateString();
  const totals = store.emailTotals();
  const aggregates = store.accountAggregates();

  const accounts = discoverAccounts().map((a) => {
    const registered = store.listEmailAccounts().some((r) => r.account === a.label);
    if (!registered) store.registerAccount(a.label); // surface auth'd-but-never-run accounts
    const ageDays = store.accountAgeDays(a.label);
    const paused = store.isAccountPaused(a.label);
    const cap = paused ? 0 : effectiveDailyCap(ageDays, a.label, day);
    const sentToday = store.sentCountOnDay(a.label, day);
    const agg = aggregates[a.label] ?? { totalSent: 0, lastSent: null };
    return {
      label: a.label,
      ageDays,
      paused,
      cap,
      sentToday,
      remaining: Math.max(cap - sentToday, 0),
      totalSent: agg.totalSent,
      lastSent: agg.lastSent,
    };
  });

  const sentToday = accounts.reduce((n, a) => n + a.sentToday, 0);
  const capacityToday = accounts.reduce((n, a) => n + a.remaining, 0);

  res.json({
    window: {
      open: inSendWindow(),
      timezone: TIMEZONE,
      startHour: SEND_START_HOUR,
      endHour: SEND_END_HOUR,
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

app.listen(config.uiPort, () => {
  console.log(`UI running at http://localhost:${config.uiPort}`);
  // Resume sending if it was left "on" (survives pm2/host restarts).
  if ((store.getState('email_sending') ?? 'off') === 'on') {
    console.log('[campaign] resuming (was on before restart)');
    startCampaign();
  }
});
