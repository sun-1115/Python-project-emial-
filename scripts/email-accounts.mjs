// Health check for every authorized Gmail account. Verifies each token can still
// refresh (catches Testing-mode 7-day expiry or revoked access), and shows the
// warm-up cap, today's usage, pause state, and lifetime sends per account.
//
//   npm run build
//   npm run email:accounts
import 'dotenv/config';

const { loadConfig } = await import('file:///e:/Work/Github%20Track/dist/config.js');
const { UserStore } = await import('file:///e:/Work/Github%20Track/dist/db.js');
const { discoverAccounts } = await import('file:///e:/Work/Github%20Track/dist/email/accounts.js');
const { verifyToken } = await import('file:///e:/Work/Github%20Track/dist/email/gmail.js');
const { effectiveDailyCap, zonedDateString } = await import(
  'file:///e:/Work/Github%20Track/dist/email/pacing.js'
);

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

  const flags = [paused ? 'PAUSED' : null].filter(Boolean).join(' ');
  console.log(`  ${acct.label.padEnd(16)} ${status}`);
  console.log(
    `  ${''.padEnd(16)} day ${ageDays} · today ${sentToday}/${cap} · lifetime ${agg.totalSent}` +
      `${agg.lastSent ? ' · last ' + agg.lastSent + ' UTC' : ' · never sent'}${flags ? ' · ' + flags : ''}\n`
  );
}

console.log(`${healthy} healthy, ${unhealthy} need attention.\n`);
store.close();
