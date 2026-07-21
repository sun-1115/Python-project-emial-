// Campaign orchestrator: rotate across many Gmail accounts, obey per-account
// warm-up caps, only send inside the EST business-hours window, and space each
// account's sends with human-like jitter. Every send is logged to sent_emails
// with its from_account so the run is idempotent, auditable, and resumable.
//
// Two run shapes:
//   daemon (default) — long-lived loop (run under pm2). Sends continuously within
//                      the window, sleeps outside it, idles when nothing to send.
//   --once           — a single sweep: one email per eligible account, then exit.
//                      Spacing comes from your cron interval. Good for scheduled runs.
import { loadConfig } from '../config.js';
import { UserStore } from '../db.js';
import { getAuthorizedClient, sendEmail } from './gmail.js';
import { discoverAccounts, Account } from './accounts.js';
import { buildBody, fillTemplate, pickTemplate, Recipient, Template } from './content.js';
import { inSendWindow, zonedDateString, effectiveDailyCap, nextGapMs } from './pacing.js';

type OAuthClient = ReturnType<typeof getAuthorizedClient>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`);

export interface CampaignOptions {
  templates: Template[]; // one is chosen at random per recipient
  defaultSubject: string; // used when a chosen template has no "Subject:" line
  dryRun?: boolean;
  once?: boolean;
  totalLimit?: number; // safety cap on sends this run (0 = unlimited)
  onlyAccount?: string; // restrict to a single account label (testing)
  isStopped?: () => boolean; // daemon exits promptly when this returns true (UI Stop)
}

interface AccountState {
  acct: Account;
  auth: OAuthClient | null;
  cap: number; // today's effective cap (ramp − small daily jitter)
  sentToday: number;
  nextReadyAt: number; // epoch ms this account may send again (daemon cooldown)
  disabled: boolean; // hit a hard limit/auth error → skip for the rest of today
}

export async function runCampaign(store: UserStore, opts: CampaignOptions): Promise<void> {
  if (!opts.templates || opts.templates.length === 0) {
    throw new Error('No message templates provided. Add at least one file to the messages folder.');
  }

  let accounts = discoverAccounts();
  if (opts.onlyAccount) accounts = accounts.filter((a) => a.label === opts.onlyAccount);
  if (accounts.length === 0) {
    throw new Error(
      'No authorized accounts found. Authorize one first: npm run email:auth -- --account <label>'
    );
  }
  log(`${opts.templates.length} message template(s) loaded: ${opts.templates.map((t) => t.name).join(', ')}`);

  const states: AccountState[] = accounts.map((acct) => {
    store.registerAccount(acct.label);
    return { acct, auth: null, cap: 0, sentToday: 0, nextReadyAt: 0, disabled: false };
  });

  // Roll the per-day counters. Called at start and whenever the EST date flips.
  let currentDay = '';
  const refreshDay = (day: string) => {
    currentDay = day;
    for (const s of states) {
      if (store.isAccountPaused(s.acct.label)) {
        s.cap = 0;
      } else {
        s.cap = effectiveDailyCap(store.accountAgeDays(s.acct.label), s.acct.label, day);
      }
      s.sentToday = store.sentCountOnDay(s.acct.label, day);
      s.disabled = false;
    }
    const total = states.reduce((n, s) => n + Math.max(s.cap - s.sentToday, 0), 0);
    log(
      `Day ${day} (EST): ${states.length} account(s), ${total} send(s) remaining today ` +
        states.map((s) => `${s.acct.label}=${s.sentToday}/${s.cap}`).join(' ')
    );
  };
  refreshDay(zonedDateString());

  // Recipient queue: all not-yet-sent users, oldest first. Refilled when drained.
  const attempted = new Set<string>(); // emails tried this run (skip error-retry loops)
  let queue: Recipient[] = [];
  let ptr = 0;
  const refill = (): boolean => {
    queue = (store.unsentRecipients() as Recipient[]).filter((r) => !attempted.has(r.email));
    ptr = 0;
    return queue.length > 0;
  };
  const nextRecipient = (): Recipient | null => {
    for (;;) {
      if (ptr >= queue.length && !refill()) return null;
      const r = queue[ptr++];
      attempted.add(r.email);
      // The queue is a snapshot; honor addresses suppressed since it was loaded.
      if (store.isSuppressed(r.email)) continue;
      return r;
    }
  };

  // --- dry run: report the plan, send nothing ---
  if (opts.dryRun) {
    refill();
    const remaining = states.reduce((n, s) => n + Math.max(s.cap - s.sentToday, 0), 0);
    log(`[dry-run] ${queue.length} unsent recipient(s); capacity today = ${remaining} send(s).`);
    for (const r of queue.slice(0, 5)) {
      const tpl = pickTemplate(opts.templates);
      const body = buildBody(tpl.body, r);
      log(`  → ${r.email} (@${r.login})  [template: ${tpl.name}]`);
      console.log(`      subject: ${fillTemplate(tpl.subject ?? opts.defaultSubject, r)}`);
      console.log(body.split('\n').map((l) => '      | ' + l).join('\n'));
    }
    log('[dry-run] Nothing sent.');
    return;
  }

  const sendOne = async (s: AccountState, r: Recipient): Promise<boolean> => {
    if (!s.auth) s.auth = getAuthorizedClient(s.acct.tokenPath);
    const tpl = pickTemplate(opts.templates); // random template per recipient
    const subject = fillTemplate(tpl.subject ?? opts.defaultSubject, r);
    const body = buildBody(tpl.body, r);
    try {
      const { id, threadId } = await sendEmail(r.email, subject, body, { auth: s.auth });
      store.recordSend({
        login: r.login, toEmail: r.email, subject, status: 'sent',
        messageId: id, threadId, fromAccount: s.acct.label, sentDay: currentDay,
      });
      s.sentToday++;
      log(`  ✓ [${s.acct.label}] ${r.email} (${s.sentToday}/${s.cap})`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.recordSend({
        login: r.login, toEmail: r.email, subject, status: 'error',
        error: msg, fromAccount: s.acct.label, sentDay: currentDay,
      });
      // Gmail signalling a sending/quota limit → retire this account for today.
      if (/limit|quota|rate.?limit|exceeded/i.test(msg)) {
        s.disabled = true;
        log(`  ⚠ [${s.acct.label}] hit a limit — pausing it for today: ${msg}`);
      } else {
        log(`  ✗ [${s.acct.label}] ${r.email} — ${msg}`);
      }
      return false;
    }
  };

  let totalSent = 0;
  const limitReached = () => opts.totalLimit != null && opts.totalLimit > 0 && totalSent >= opts.totalLimit;

  // --- single sweep: one send per eligible account, then exit ---
  if (opts.once) {
    if (!inSendWindow()) {
      log('Outside the send window (EST business hours). Nothing sent.');
      return;
    }
    for (const s of states) {
      if (limitReached()) break;
      if (s.disabled || s.sentToday >= s.cap) continue;
      const r = nextRecipient();
      if (!r) break;
      if (await sendOne(s, r)) totalSent++;
    }
    log(`Sweep done. Sent ${totalSent} this run.`);
    return;
  }

  // --- daemon: continuous, window-aware, cooldown-paced ---
  // Interruptible sleep: wakes early (within ~1s) when the UI asks us to stop.
  const stopped = () => Boolean(opts.isStopped?.());
  const nap = async (ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopped()) return;
      await sleep(Math.min(1_000, end - Date.now()));
    }
  };

  log('Daemon started.');
  for (;;) {
    if (stopped()) {
      log('Stop requested — daemon exiting.');
      return;
    }
    if (limitReached()) {
      log(`Reached run limit of ${opts.totalLimit}. Stopping.`);
      return;
    }

    const today = zonedDateString();
    if (today !== currentDay) refreshDay(today);

    if (!inSendWindow()) {
      await nap(60_000); // re-check every minute until the window opens
      continue;
    }

    const eligible = states.filter((s) => !s.disabled && s.sentToday < s.cap);
    if (eligible.length === 0) {
      log('All accounts at their daily cap. Sleeping until the next day/window…');
      await nap(10 * 60_000);
      continue;
    }

    const now = Date.now();
    const ready = eligible.filter((s) => s.nextReadyAt <= now);
    if (ready.length === 0) {
      const soonest = Math.min(...eligible.map((s) => s.nextReadyAt));
      await nap(Math.min(Math.max(soonest - now, 1_000), 60_000));
      continue;
    }

    // Prefer the account that has sent the least today, to spread load evenly.
    ready.sort((a, b) => a.sentToday - b.sentToday || a.nextReadyAt - b.nextReadyAt);
    const s = ready[0];

    const r = nextRecipient();
    if (!r) {
      log('No more recipients to send. Idling (crawler may add more)…');
      await nap(5 * 60_000);
      continue;
    }

    if (await sendOne(s, r)) totalSent++;
    s.nextReadyAt = Date.now() + nextGapMs(); // human-like gap before this account sends again
  }
}
