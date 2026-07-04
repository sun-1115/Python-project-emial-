import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { UserStore, SORT_SQL, type SortKey } from './db.js';

const config = loadConfig();
const store = new UserStore(config.dbPath);
const app = express();

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

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

app.listen(config.uiPort, () => {
  console.log(`UI running at http://localhost:${config.uiPort}`);
});
