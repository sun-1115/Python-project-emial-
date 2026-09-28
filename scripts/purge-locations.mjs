// Re-apply the UK location filter to rows ALREADY in the database.
//
// The crawler filters on the way in, so tightening src/location.ts only affects
// future crawls — users saved under a looser rule stay until they're purged.
// Run this after any change to the location heuristics.
//
// Dry run (default) — prints what would go, deletes nothing:
//   npm run build && npm run db:purge
// Actually delete:
//   npm run db:purge -- --apply
import 'dotenv/config';
import { load } from './_dist.mjs';

const { loadConfig } = await load('config.js');
const { UserStore } = await load('db.js');
const { isUkOrEmpty } = await load('location.js');

const apply = process.argv.includes('--apply');
const cfg = loadConfig();
const store = new UserStore(cfg.dbPath);

// Inspect first: purge() deletes, so the dry run must not call it.
const rows = store.allLocations();
const doomed = rows.filter((r) => !isUkOrEmpty(r.location));

if (doomed.length === 0) {
  console.log(`All ${rows.length} users pass the current filter. Nothing to purge.`);
  process.exit(0);
}

const byLoc = new Map();
for (const r of doomed) byLoc.set(r.location ?? '', (byLoc.get(r.location ?? '') ?? 0) + 1);

console.log(`${doomed.length} of ${rows.length} users no longer pass the UK filter:\n`);
for (const [loc, n] of [...byLoc].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(5)}  ${loc || '(empty)'}`);
}
if (byLoc.size > 25) console.log(`  ${' '.repeat(5)}  … and ${byLoc.size - 25} more distinct locations`);

if (!apply) {
  console.log(`\nDry run — nothing deleted. Re-run with --apply to remove these ${doomed.length} users.`);
  process.exit(0);
}

const removed = store.purge(isUkOrEmpty);
console.log(`\nDeleted ${removed} users. ${rows.length - removed} remain.`);
