// Backfill emails for users already in the DB that have none, using the same
// resolver the crawler uses (profile → commit → bio). Read-safe to run while the
// crawler is going (busy_timeout handles brief lock contention).
//
//   node scripts/backfill-emails.mjs           → fill missing emails
//   node scripts/backfill-emails.mjs --purge   → after filling, DELETE rows still emailless
import { DatabaseSync } from 'node:sqlite';

const { GitHubClient } = await import('file:///e:/Work/Github%20Track/dist/github.js');
const { loadConfig } = await import('file:///e:/Work/Github%20Track/dist/config.js');

const cfg = loadConfig();
const purge = process.argv.includes('--purge');
const gh = new GitHubClient(cfg.githubToken);

const db = new DatabaseSync(cfg.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 15000;');

const targets = db.prepare('SELECT login FROM users WHERE email IS NULL ORDER BY id').all();
console.log(`Backfilling emails for ${targets.length} users missing one...`);

const upd = db.prepare(
  "UPDATE users SET email = ?, email_source = ?, last_fetched_at = datetime('now') WHERE login = ?"
);

let done = 0;
let found = 0;
for (const { login } of targets) {
  try {
    const { email, source } = await gh.getEmail(login);
    if (email) {
      upd.run(email, source, login);
      found++;
    }
  } catch (err) {
    // profile gone (404) etc. — skip; the purge step will remove it if still emailless
  }
  if (++done % 25 === 0) {
    console.log(`  ${done}/${targets.length} processed, ${found} emails recovered`);
  }
}
console.log(`Backfill done: recovered ${found} emails out of ${targets.length}.`);

if (purge) {
  const before = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const res = db.prepare('DELETE FROM users WHERE email IS NULL').run();
  const after = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  console.log(`Purged ${res.changes} emailless users (${before} → ${after}).`);
} else {
  const remaining = db.prepare('SELECT COUNT(*) c FROM users WHERE email IS NULL').get().c;
  console.log(`${remaining} users still have no email. Re-run with --purge to delete them.`);
}

db.close();
