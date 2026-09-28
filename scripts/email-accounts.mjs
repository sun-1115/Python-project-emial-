// Health check for every authorized Gmail account. Verifies each token can still
// refresh (catches Testing-mode 7-day expiry or revoked access), and shows the
// warm-up cap, today's usage, pause state, and lifetime sends per account.
//
//   npm run build
//   npm run email:accounts
import 'dotenv/config';

import { load } from './_dist.mjs';

const { loadConfig } = await load('config.js');
const { UserStore } = await load('db.js');
const { discoverAccounts } = await load('email/accounts.js');
const { verifyToken, checkAccountIdentity } = await load("email/gmail.js");
const { effectiveDailyCap, zonedDateString } = await load('email/pacing.js');

const accounts = discoverAccounts();
if (accounts.length === 0) {
  console.log('No accounts found. Authorize one:  npm run email:auth -- --account <label>');
  process.exit(0);
}

const cfg = loadConfig();
const store = new UserStore(cfg.dbPath);
const day = zonedDateString();
const aggregates = store.accountAggregates();

console.log(`\nChecking ${accounts.length} account(s)…\n`);

let healthy = 0;
let unhealthy = 0;
let mismatched = 0;
let unverified = 0;

// mailbox -> labels using it. Two labels sharing one mailbox is the dangerous
// case: that mailbox quietly sends BOTH accounts' quotas (blowing past its daily
// cap and its reputation budget) while the other account sends nothing at all.
// Neither label looks wrong on its own, so only this cross-check finds it.
const mailboxUsers = new Map();

for (const acct of accounts) {
  store.registerAccount(acct.label);
  const v = await verifyToken(acct.tokenPath);
  const ageDays = store.accountAgeDays(acct.label);
  const paused = store.isAccountPaused(acct.label);
  const cap = paused ? 0 : effectiveDailyCap(ageDays, acct.label, day);
  const sentToday = store.sentCountOnDay(acct.label, day);
  const agg = aggregates[acct.label] ?? { totalSent: 0, lastSent: null };

  let status;
  if (v.ok && v.hasRefresh) { status = '✓ healthy'; healthy++; }
  else if (v.ok && !v.hasRefresh) { status = '⚠ no refresh_token (re-auth to make it persistent)'; unhealthy++; }
  else { status = `✗ BROKEN — ${v.error || 'cannot refresh'} (re-run email:auth)`; unhealthy++; }

  // A refreshable token proves only that SOME account consented — not which one.
  // Identity is what ties these stats to a real mailbox.
  const id = checkAccountIdentity(acct.label, acct.tokenPath);
  if (id.status === 'mismatch') mismatched++;
  else if (id.status === 'unverified') unverified++;
  if (id.mailbox) {
    const key = id.mailbox.toLowerCase();
    mailboxUsers.set(key, [...(mailboxUsers.get(key) ?? []), acct.label]);
  }
  const identity =
    id.status === 'ok'
      ? `mailbox ${id.mailbox}`
      : id.status === 'mismatch'
        ? `✗ MAILBOX MISMATCH — this token actually sends as ${id.mailbox}`
        : '? mailbox unverified (token predates the identity scope — re-run email:auth)';

  const flags = [paused ? 'PAUSED' : null].filter(Boolean).join(' ');
  console.log(`  ${acct.label.padEnd(16)} ${status}`);
  console.log(`  ${''.padEnd(16)} ${identity}`);
  console.log(
    `  ${''.padEnd(16)} day ${ageDays} · today ${sentToday}/${cap} · lifetime ${agg.totalSent}` +
      `${agg.lastSent ? ' · last ' + agg.lastSent + ' UTC' : ' · never sent'}${flags ? ' · ' + flags : ''}\n`
  );
}

const shared = [...mailboxUsers.entries()].filter(([, labels]) => labels.length > 1);

console.log(`${healthy} healthy, ${unhealthy} need attention.`);
if (shared.length > 0) {
  console.log(`\n✗ ${shared.length} MAILBOX(ES) SHARED BY MORE THAN ONE ACCOUNT:`);
  for (const [mailbox, labels] of shared) {
    const total = labels.reduce((n, l) => n + store.sentCountOnDay(l, day), 0);
    console.log(`    ${mailbox} is used by: ${labels.join(', ')}`);
    console.log(
      `      → that ONE mailbox actually sent ${total} message(s) today (the sum of those` +
        ` labels), not the per-label numbers above. The other account sent nothing.`
    );
  }
  console.log('    Re-run email:auth for the wrong label, signed in as the account it names.');
}
if (mismatched > 0)
  console.log(
    `${mismatched} MISLABELLED — their sends are being recorded under the wrong account name.`
  );
if (unverified > 0)
  console.log(
    `${unverified} unverified — re-run "npm run email:auth -- --account <label>" to confirm\n` +
      `which mailbox each token belongs to. Until then from_account is an assumption.`
  );
console.log();
store.close();
