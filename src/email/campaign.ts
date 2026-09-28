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
import { resolveMx } from 'node:dns/promises';
import { statSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { UserStore } from '../db.js';
import { getAuthorizedClient, sendEmail, hasSendScope, MISSING_SCOPE_HINT } from './gmail.js';
import { discoverAccounts, Account } from './accounts.js';
import { buildBody, fillTemplate, pickTemplate, textToHtml, Recipient, Template } from './content.js';
import { isPersonalEmail } from '../github.js';
import {
  inSendWindow,
  inSendOrCatchupWindow,
  inCatchupHours,
  zonedDateString,
  effectiveDailyCap,
  nextGapMs,
} from './pacing.js';

type OAuthClient = ReturnType<typeof getAuthorizedClient>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`);

// --- Deliverability filters (cut the "address not found" bounce rate) ---
// Personal-only: only send to free-provider mailboxes (gmail/outlook/…). These
// almost never bounce; company/.edu/custom domains are where dead addresses
// concentrate. On by default; set EMAIL_PERSONAL_ONLY=false to send to all.
const PERSONAL_ONLY = process.env.EMAIL_PERSONAL_ONLY !== 'false';
// MX check: skip (and suppress) addresses whose domain provably can't receive
// mail. OFF by default — it's redundant when PERSONAL_ONLY is on (personal
// providers always have MX), and it's dangerous where DNS is unreliable (a
// failing resolver would mark everything undeliverable). Opt in with
// EMAIL_MX_CHECK=true only where MX lookups are known to work.
const MX_CHECK = process.env.EMAIL_MX_CHECK === 'true';
// Send text + HTML (multipart/alternative). Text-only messages are rendered by
// Gmail in its plain-text style — a narrow fixed-width column with hard wraps
// mid-sentence. Set EMAIL_HTML=false to go back to text-only.
const SEND_HTML = process.env.EMAIL_HTML !== 'false';

const mxCache = new Map<string, boolean>();
/**
 * True if the address's domain can accept mail. FAIL-OPEN: only a definitive
 * "no such domain / no MX data" answer (ENOTFOUND/ENODATA) marks it
 * undeliverable; any resolver/network error is treated as deliverable so a DNS
 * hiccup never mass-suppresses the list.
 */
async function domainAcceptsMail(email: string): Promise<boolean> {
  if (!MX_CHECK) return true;
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  if (!domain) return false; // genuinely malformed
  const cached = mxCache.get(domain);
  if (cached !== undefined) return cached;
  let ok = true; // fail open
  try {
    const mx = await resolveMx(domain);
    ok = Array.isArray(mx) && mx.length > 0;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    ok = !(code === 'ENOTFOUND' || code === 'ENODATA'); // only these mean "no mail server"
  }
  mxCache.set(domain, ok);
  return ok;
}

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
  tokenStamp: number; // mtime of the token file `auth` was built from (re-auth detection)
  cap: number; // today's effective cap (ramp − small daily jitter)
  sentToday: number;
  nextReadyAt: number; // epoch ms this account may send again (daemon cooldown)
  disabled: boolean; // hit a hard limit/auth error → skip for the rest of today
  scopeBlocked: boolean; // token proven to lack gmail.send (logged once, re-checked each tick)
  paused: boolean; // operator pause, re-read from the DB every tick
  failStreak: number; // consecutive failures → back off, then retire for the day
}

export async function runCampaign(store: UserStore, opts: CampaignOptions): Promise<void> {
  if (!opts.templates || opts.templates.length === 0) {
    throw new Error('No message templates provided. Add at least one file to the messages folder.');
  }

  const listAccounts = (): Account[] => {
    const all = discoverAccounts();
    return opts.onlyAccount ? all.filter((a) => a.label === opts.onlyAccount) : all;
  };
  if (listAccounts().length === 0) {
    throw new Error(
      'No authorized accounts found. Authorize one first: npm run email:auth -- --account <label>'
    );
  }
  log(`${opts.templates.length} message template(s) loaded: ${opts.templates.map((t) => t.name).join(', ')}`);

  const states: AccountState[] = [];
  const byLabel = new Map<string, AccountState>();

  /** Last-write time of a token file — changes when the account is re-authorized. */
  const tokenStamp = (path: string): number => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  };

  /**
   * Re-read everything that can change underneath a long-lived daemon: which
   * accounts are authorized, each one's pause flag and cap, and whether its
   * token file was rewritten. Cheap (one readdir + a few indexed lookups), so
   * it runs every tick — pausing, resuming, re-authorizing or adding an account
   * in the UI takes effect within seconds. Snapshotting this only at the day
   * roll used to strand an account: paused at midnight meant cap=0 for the whole
   * day, so it was skipped silently — no attempt, no error — even after a resume.
   */
  let booted = false; // suppresses "newly authorized" noise for the initial roster
  const syncAccounts = (day: string) => {
    const live = listAccounts();
    for (const acct of live) {
      let s = byLabel.get(acct.label);
      if (!s) {
        store.registerAccount(acct.label);
        s = {
          acct,
          auth: null,
          tokenStamp: tokenStamp(acct.tokenPath),
          cap: 0,
          sentToday: store.sentCountOnDay(acct.label, day),
          nextReadyAt: 0,
          disabled: false,
          scopeBlocked: false,
          paused: false,
          failStreak: 0,
        };
        byLabel.set(acct.label, s);
        states.push(s);
        if (booted) log(`  + [${acct.label}] newly authorized account picked up`);
      }
      s.acct = acct;

      // Re-authorized: drop the cached OAuth client so the new refresh token is
      // used, and give the account a clean slate for the rest of the day.
      const stamp = tokenStamp(acct.tokenPath);
      if (stamp !== s.tokenStamp) {
        s.tokenStamp = stamp;
        s.auth = null;
        s.disabled = false;
        s.failStreak = 0;
        log(`  ↻ [${acct.label}] token file changed — re-reading credentials`);
      }

      // Pre-flight: a token that was never granted gmail.send cannot send, and
      // Google only says so at the moment of sending — by which point a
      // recipient has been pulled from the queue and an error row written for a
      // problem that is purely local. Catching it here costs one file read and
      // keeps the queue intact. Re-checked every tick, so a correct re-auth
      // brings the account straight back.
      const scopeBlocked = hasSendScope(acct.tokenPath) === false;
      if (scopeBlocked && !s.scopeBlocked) {
        log(`  ⚠ [${acct.label}] ${MISSING_SCOPE_HINT} — skipping this account`);
      } else if (!scopeBlocked && s.scopeBlocked) {
        s.disabled = false; // re-authorized with the Gmail box ticked
        s.failStreak = 0;
        log(`  ✓ [${acct.label}] gmail.send granted — account is sending again`);
      }
      s.scopeBlocked = scopeBlocked;
      if (scopeBlocked) s.disabled = true;

      const paused = store.isAccountPaused(acct.label);
      if (s.paused !== paused) {
        if (!paused) {
          // An explicit resume is an operator saying "this one is fixed".
          s.disabled = false;
          s.failStreak = 0;
        }
        log(`  ${paused ? '⏸' : '▶'} [${acct.label}] ${paused ? 'paused' : 'resumed'}`);
      }
      s.paused = paused;
      s.cap = paused ? 0 : effectiveDailyCap(store.accountAgeDays(acct.label), acct.label, day);
    }
    // Token file deleted → stop sending as that account (keep its counters).
    const seen = new Set(live.map((a) => a.label));
    for (const s of states) if (!seen.has(s.acct.label)) s.cap = 0;
    booted = true;
  };

  // Roll the per-day counters. Called at start and whenever the EST date flips.
  let currentDay = '';
  const refreshDay = (day: string) => {
    currentDay = day;
    for (const s of states) {
      s.sentToday = store.sentCountOnDay(s.acct.label, day);
      s.disabled = false;
      s.failStreak = 0;
      s.nextReadyAt = 0; // yesterday's cooldown must not carry into the new day
    }
    syncAccounts(day);
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
    let list = store.unsentRecipients() as Recipient[];
    // Personal-only: drop company/.edu/custom-domain addresses up front — these
    // are where "address not found" bounces concentrate. Skipped, not suppressed,
    // so flipping EMAIL_PERSONAL_ONLY back off restores them.
    if (PERSONAL_ONLY) list = list.filter((r) => isPersonalEmail(r.email));
    queue = list.filter((r) => !attempted.has(r.email));
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

  /** Consecutive failures after which an account is retired for the day. */
  const MAX_FAIL_STREAK = 5;

  const sendOne = async (s: AccountState, r: Recipient): Promise<boolean> => {
    const tpl = pickTemplate(opts.templates); // random template per recipient
    const subject = fillTemplate(tpl.subject ?? opts.defaultSubject, r);
    const body = buildBody(tpl.body, r);
    try {
      // Inside the try: a malformed/unreadable token file throws here, and that
      // must retire one account — not tear down the whole daemon.
      if (!s.auth) s.auth = getAuthorizedClient(s.acct.tokenPath);
      const { id, threadId } = await sendEmail(r.email, subject, body, {
        auth: s.auth,
        ...(SEND_HTML ? { html: textToHtml(body) } : {}),
      });
      store.recordSend({
        login: r.login, toEmail: r.email, subject, status: 'sent',
        messageId: id, threadId, fromAccount: s.acct.label, sentDay: currentDay,
      });
      s.sentToday++;
      s.failStreak = 0;
      log(`  ✓ [${s.acct.label}] ${r.email} (${s.sentToday}/${s.cap})`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.recordSend({
        login: r.login, toEmail: r.email, subject, status: 'error',
        error: msg, fromAccount: s.acct.label, sentDay: currentDay,
      });
      s.failStreak++;
      // Gmail signalling a sending/quota limit → retire this account for today.
      if (/limit|quota|rate.?limit|exceeded/i.test(msg)) {
        s.disabled = true;
        log(`  ⚠ [${s.acct.label}] hit a limit — pausing it for today: ${msg}`);
      } else if (/insufficient authentication scopes|insufficient_scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg)) {
        // Authenticates fine, cannot send: the Gmail checkbox was left unticked
        // at consent. Retrying only burns recipients — retire until re-authorized.
        s.disabled = true;
        s.auth = null;
        log(`  ⚠ [${s.acct.label}] ${MISSING_SCOPE_HINT} — retiring until re-authorized`);
      } else if (/invalid_grant|unauthorized|invalid_credentials|401/i.test(msg)) {
        // Dead refresh token: every further attempt burns a fresh recipient for
        // nothing. Retire it until the token file is replaced (Re-auth clears this).
        s.disabled = true;
        s.auth = null;
        log(`  ⚠ [${s.acct.label}] credentials rejected — retiring until re-authorized: ${msg}`);
      } else if (s.failStreak >= MAX_FAIL_STREAK) {
        s.disabled = true;
        log(`  ⚠ [${s.acct.label}] ${s.failStreak} failures in a row — retiring it for today: ${msg}`);
      } else {
        log(`  ✗ [${s.acct.label}] ${r.email} — ${msg}`);
      }
      return false;
    }
  };

  let totalSent = 0;
  const limitReached = () => opts.totalLimit != null && opts.totalLimit > 0 && totalSent >= opts.totalLimit;

  // Final pre-send gate: if the recipient's domain can't receive mail, suppress
  // it (reason 'no-mx') so it's never tried again, and skip. Returns true to send.
  const deliverable = async (r: Recipient): Promise<boolean> => {
    if (await domainAcceptsMail(r.email)) return true;
    store.addSuppressions([r.email], 'no-mx');
    log(`  ⤫ ${r.email} — domain has no MX record, suppressed`);
    return false;
  };

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
      if (!(await deliverable(r))) continue;
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
    // Pick up pause/resume, re-auths and new accounts as they happen; a date
    // change additionally rolls the per-day counters.
    if (today !== currentDay) refreshDay(today);
    else syncAccounts(today);

    // Send during business hours, and — if a catch-up extension is configured —
    // keep going past the window until each account reaches its daily cap.
    if (!inSendOrCatchupWindow()) {
      await nap(60_000); // re-check every minute until the window opens
      continue;
    }

    const eligible = states.filter((s) => !s.disabled && s.sentToday < s.cap);
    if (eligible.length === 0) {
      // Everyone's at cap. In catch-up hours that means the day is fully caught
      // up, so there's nothing left to extend for — nap until the next window.
      log('All accounts at their daily cap. Sleeping until the next day/window…');
      await nap(10 * 60_000);
      continue;
    }

    // Note when we're sending past the normal window to finish the day's quota.
    if (!inSendWindow() && inCatchupHours()) {
      const behind = eligible.reduce((n, s) => n + (s.cap - s.sentToday), 0);
      log(`Catch-up: past the window, ${behind} send(s) still owed today — continuing.`);
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

    if (!(await deliverable(r))) continue; // bad domain — suppressed, try another
    if (await sendOne(s, r)) totalSent++;
    s.nextReadyAt = Date.now() + nextGapMs(); // human-like gap before this account sends again
  }
}
