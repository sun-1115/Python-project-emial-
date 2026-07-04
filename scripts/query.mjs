// Ad-hoc SQL viewer for the users DB. Read-only, so it's safe to run while the
// crawler is writing.
//   node scripts/query.mjs                         → summary + top 10 by followers
//   node scripts/query.mjs "SELECT ... "           → run any SQL, print as a table
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.env.DB_PATH || './data/github-users.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

const sql = process.argv.slice(2).join(' ').trim();

if (!sql) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM users').get();
  console.log(`Database: ${dbPath}`);
  console.log(`Total users: ${c}\n`);
  console.log('Top 10 by followers:');
  console.table(
    db
      .prepare(
        `SELECT id, login, followers, public_repos, location
         FROM users ORDER BY followers DESC LIMIT 10`
      )
      .all()
  );
  console.log('\nTip: pass your own query, e.g.');
  console.log(`  node scripts/query.mjs "SELECT login, location FROM users WHERE location LIKE '%Texas%' LIMIT 20"`);
} else {
  const rows = db.prepare(sql).all();
  if (rows.length) console.table(rows);
  else console.log('(no rows)');
}

db.close();
