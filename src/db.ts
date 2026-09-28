import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UserRecord {
  id?: number; // surrogate PK (auto-increment) — assigned by SQLite, not on insert
  login: string; // username — UNIQUE (natural key for dedup)
  github_id: number | null;
  name: string | null;
  avatar_url: string | null;
  html_url: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
  email_source: string | null; // where the email came from: 'profile' | 'commit' | 'bio'
  telegram: string | null;
  bio: string | null;
  blog: string | null;
  public_repos: number | null;
  followers: number | null;
  following: number | null;
  github_created_at: string | null;
  discovered_via: 'search' | 'contributor';
}

export interface ListOptions {
  q?: string;
  cursor?: string; // last login from previous page (keyset pagination)
  limit?: number;
  sort?: 'username' | 'followers';
}

/** The sort keys the UI can request → the SQL ORDER BY each maps to. */
export type SortKey =
  | 'id'            // insertion order (auto-increment id ascending)
  | 'id_desc'       // newest rows first (id descending)
  | 'username'      // A–Z
  | 'username_desc' // Z–A
  | 'followers'     // most followers
  | 'followers_asc' // fewest followers
  | 'repos'         // most public repos
  | 'newest'        // newest GitHub account
  | 'oldest'        // oldest GitHub account
  | 'recent';       // most recently discovered by the crawler

export const SORT_SQL: Record<SortKey, string> = {
  id: 'id ASC',
  id_desc: 'id DESC',
  username: 'login ASC',
  username_desc: 'login DESC',
  followers: 'followers DESC NULLS LAST, login ASC',
  followers_asc: 'followers ASC NULLS LAST, login ASC',
  repos: 'public_repos DESC NULLS LAST, login ASC',
  newest: 'github_created_at DESC NULLS LAST, login ASC',
  oldest: 'github_created_at ASC NULLS LAST, login ASC',
  recent: 'first_seen_at DESC, login ASC',
};

export interface PageOptions {
  q?: string;
  page?: number; // 1-based
  pageSize?: number;
  sort?: SortKey;
}

export interface Page {
  users: UserRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export class UserStore {
  private db: DatabaseSync;
  private upsertStmt: ReturnType<DatabaseSync['prepare']>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Wait up to 8s on a locked DB instead of failing — lets the crawler and a
    // concurrent backfill/query share the file gracefully.
    this.db.exec('PRAGMA busy_timeout = 8000;');
    this.migrate();

    // Upsert by username. Keep first_seen_at and don't downgrade a 'search'
    // discovery to 'contributor' on later runs.
    this.upsertStmt = this.db.prepare(`
      INSERT INTO users (
        login, github_id, name, avatar_url, html_url, company, location, email,
        email_source, telegram, bio, blog, public_repos, followers, following,
        github_created_at, discovered_via, first_seen_at, last_fetched_at
      ) VALUES (
        :login, :github_id, :name, :avatar_url, :html_url, :company, :location, :email,
        :email_source, :telegram, :bio, :blog, :public_repos, :followers, :following,
        :github_created_at, :discovered_via, datetime('now'), datetime('now')
      )
      ON CONFLICT(login) DO UPDATE SET
        github_id = excluded.github_id,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        html_url = excluded.html_url,
        company = excluded.company,
        location = excluded.location,
        -- Never lose a found email/handle: keep the existing one if the new fetch is null.
        email = COALESCE(excluded.email, users.email),
        email_source = COALESCE(excluded.email_source, users.email_source),
        telegram = COALESCE(excluded.telegram, users.telegram),
        bio = excluded.bio,
        blog = excluded.blog,
        public_repos = excluded.public_repos,
        followers = excluded.followers,
        following = excluded.following,
        github_created_at = excluded.github_created_at,
        discovered_via =
          CASE WHEN users.discovered_via = 'search' THEN 'search'
               ELSE excluded.discovered_via END,
        last_fetched_at = datetime('now')
    `);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT NOT NULL UNIQUE,
        github_id INTEGER,
        name TEXT,
        avatar_url TEXT,
        html_url TEXT,
        company TEXT,
        location TEXT,
        email TEXT,
        email_source TEXT,
        telegram TEXT,
        bio TEXT,
        blog TEXT,
        public_repos INTEGER,
        followers INTEGER,
        following INTEGER,
        github_created_at TEXT,
        discovered_via TEXT,
        first_seen_at TEXT NOT NULL,
        last_fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_followers ON users(followers DESC);
      CREATE INDEX IF NOT EXISTS idx_users_location ON users(location);

      CREATE TABLE IF NOT EXISTS crawl_state (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- One row per send attempt by the email bot. Gives the campaign runner
      -- idempotency (skip anyone already 'sent') and a full audit trail.
      CREATE TABLE IF NOT EXISTS sent_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT,                 -- users.login this was sent to (NULL for ad-hoc sends)
        to_email TEXT NOT NULL,
        subject TEXT,
        status TEXT NOT NULL,       -- 'sent' | 'error'
        message_id TEXT,            -- Gmail message id on success
        thread_id TEXT,
        error TEXT,                 -- error message on failure
        from_account TEXT,          -- which sending account handled it (for per-account caps/audit)
        sent_day TEXT,              -- calendar date (UK time) of the send, for daily-cap counting
        sent_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sent_login ON sent_emails(login);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sent_ok
        ON sent_emails(to_email) WHERE status = 'sent';
      CREATE INDEX IF NOT EXISTS idx_sent_acct_day
        ON sent_emails(from_account, sent_day) WHERE status = 'sent';

      -- One row per sending identity. created_at drives the warm-up ramp
      -- (a fresh account gets a low daily cap that grows with age); paused lets
      -- you retire an account that's degrading without deleting its history.
      CREATE TABLE IF NOT EXISTS email_accounts (
        account TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        note TEXT
      );

      -- Do-not-email list: opt-outs ("unsubscribe" replies) and hard bounces.
      -- The campaign never sends to an address listed here. Stored lowercased.
      CREATE TABLE IF NOT EXISTS suppressions (
        email TEXT PRIMARY KEY,
        reason TEXT,                -- 'unsubscribe' | 'bounce' | 'manual' | free text
        added_at TEXT NOT NULL
      );
    `);

    // Add columns introduced after the first release, for existing databases.
    const cols = this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'telegram')) {
      this.db.exec('ALTER TABLE users ADD COLUMN telegram TEXT');
    }
    if (!cols.some((c) => c.name === 'email_source')) {
      this.db.exec('ALTER TABLE users ADD COLUMN email_source TEXT');
    }

    // sent_emails gained multi-account columns after its first release.
    const sentCols = this.db.prepare('PRAGMA table_info(sent_emails)').all() as { name: string }[];
    if (sentCols.length > 0) {
      if (!sentCols.some((c) => c.name === 'from_account')) {
        this.db.exec('ALTER TABLE sent_emails ADD COLUMN from_account TEXT');
      }
      if (!sentCols.some((c) => c.name === 'sent_day')) {
        this.db.exec('ALTER TABLE sent_emails ADD COLUMN sent_day TEXT');
      }
    }


    this.migrateToSurrogateId();
  }

  /**
   * Upgrade an OLD-schema database (login as PRIMARY KEY, no `id`) to the new
   * schema (auto-increment `id` PK, login UNIQUE) WITHOUT losing data. SQLite
   * can't add a PK via ALTER TABLE, so we copy rows into a fresh table and swap.
   * No-op if the table already has an `id` column.
   */
  private migrateToSurrogateId(): void {
    const cols = this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    if (cols.some((c) => c.name === 'id')) return; // already migrated

    // Copy every existing column across; `id` is auto-assigned by AUTOINCREMENT.
    const colNames = cols.map((c) => c.name).join(', ');
    this.db.exec('BEGIN');
    try {
      this.db.exec(`
        ALTER TABLE users RENAME TO users_legacy;

        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          login TEXT NOT NULL UNIQUE,
          github_id INTEGER,
          name TEXT,
          avatar_url TEXT,
          html_url TEXT,
          company TEXT,
          location TEXT,
          email TEXT,
          email_source TEXT,
          telegram TEXT,
          bio TEXT,
          blog TEXT,
          public_repos INTEGER,
          followers INTEGER,
          following INTEGER,
          github_created_at TEXT,
          discovered_via TEXT,
          first_seen_at TEXT NOT NULL,
          last_fetched_at TEXT NOT NULL
        );

        INSERT INTO users (${colNames})
        SELECT ${colNames} FROM users_legacy;

        DROP TABLE users_legacy;

        CREATE INDEX IF NOT EXISTS idx_users_followers ON users(followers DESC);
        CREATE INDEX IF NOT EXISTS idx_users_location ON users(location);
      `);
      this.db.exec('COMMIT');
      console.log('[db] Migrated users table to auto-increment id (data preserved).');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Insert or update one user. Returns true if it was a new row. */
  upsert(user: UserRecord): boolean {
    const before = this.count();
    this.upsertStmt.run(user as unknown as Record<string, string | number | null>);
    return this.count() > before;
  }

  has(login: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM users WHERE login = ? LIMIT 1')
      .get(login);
    return row !== undefined;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return row.c;
  }

  /** Persistent key/value for crawl progress (e.g. the deep-split cursor). */
  getState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM crawl_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO crawl_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  /**
   * Page through users for the UI.
   * - sort 'username' uses keyset pagination on the login PK (scales to huge tables).
   * - sort 'followers' returns the top rows by follower count (single bounded query).
   */
  list(opts: ListOptions): UserRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
    const cols = `id, login, github_id, name, avatar_url, html_url, company, location,
                  email, email_source, telegram, bio, public_repos, followers, following, discovered_via`;
    const params: Record<string, string | number> = { limit };
    const where: string[] = [];

    if (opts.q) {
      where.push('(login LIKE :q OR name LIKE :q OR location LIKE :q OR email LIKE :q OR company LIKE :q)');
      params.q = `%${opts.q}%`;
    }

    if (opts.sort === 'followers') {
      const sql = `SELECT ${cols} FROM users
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY followers DESC NULLS LAST, login ASC
                   LIMIT :limit`;
      return this.db.prepare(sql).all(params) as unknown as UserRecord[];
    }

    // default: keyset by username
    if (opts.cursor) {
      where.push('login > :cursor');
      params.cursor = opts.cursor;
    }
    const sql = `SELECT ${cols} FROM users
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY login ASC
                 LIMIT :limit`;
    return this.db.prepare(sql).all(params) as unknown as UserRecord[];
  }

  /** Classic page-numbered listing (LIMIT/OFFSET) for the UI's pagination controls. */
  page(opts: PageOptions): Page {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 24, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const cols = `id, login, github_id, name, avatar_url, html_url, company, location,
                  email, email_source, telegram, bio, public_repos, followers, following, discovered_via`;

    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (opts.q) {
      where.push('(login LIKE :q OR name LIKE :q OR location LIKE :q OR email LIKE :q OR company LIKE :q)');
      params.q = `%${opts.q}%`;
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM users ${whereSql}`).get(params) as { c: number }
    ).c;

    // Whitelist the sort key (never interpolate raw user input into SQL).
    const orderBy = 'ORDER BY ' + (SORT_SQL[opts.sort as SortKey] ?? SORT_SQL.username);

    const rows = this.db
      .prepare(`SELECT ${cols} FROM users ${whereSql} ${orderBy} LIMIT :limit OFFSET :offset`)
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as unknown as UserRecord[];

    return { users: rows, total, page, pageSize, totalPages: Math.max(Math.ceil(total / pageSize), 1) };
  }

  /** Every login + location, for previewing a purge without deleting anything. */
  allLocations(): { login: string; location: string | null }[] {
    return this.db.prepare('SELECT login, location FROM users').all() as unknown as {
      login: string;
      location: string | null;
    }[];
  }

  /** Delete rows whose location fails the given predicate. Returns count removed. */
  purge(shouldKeep: (location: string | null) => boolean): number {
    const rows = this.db.prepare('SELECT login, location FROM users').all() as {
      login: string;
      location: string | null;
    }[];
    const del = this.db.prepare('DELETE FROM users WHERE login = ?');
    let removed = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        if (!shouldKeep(r.location)) {
          del.run(r.login);
          removed++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return removed;
  }

  /**
   * Recipients for the email bot: users that have an email and have NOT already
   * been sent to successfully. Ordered by id so runs are resumable/stable.
   */
  unsentRecipients(limit?: number): { login: string; email: string; name: string | null }[] {
    const cap = Math.max(limit ?? 0, 0);
    const sql = `
      SELECT u.login, u.email, u.name
      FROM users u
      WHERE u.email IS NOT NULL AND u.email <> ''
        AND NOT EXISTS (
          SELECT 1 FROM sent_emails s
          WHERE s.status = 'sent' AND s.to_email = u.email
        )
        AND NOT EXISTS (
          SELECT 1 FROM suppressions x WHERE x.email = lower(u.email)
        )
      ORDER BY u.id
      ${cap > 0 ? 'LIMIT :limit' : ''}`;
    const rows = cap > 0 ? this.db.prepare(sql).all({ limit: cap }) : this.db.prepare(sql).all();
    return rows as unknown as { login: string; email: string; name: string | null }[];
  }

  /** True if this address already has a successful send logged. */
  wasSent(toEmail: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sent_emails WHERE status = 'sent' AND to_email = ? LIMIT 1")
      .get(toEmail);
    return row !== undefined;
  }

  /** Log the outcome of one send (success or failure). */
  recordSend(entry: {
    login: string | null;
    toEmail: string;
    subject: string | null;
    status: 'sent' | 'error';
    messageId?: string | null;
    threadId?: string | null;
    error?: string | null;
    fromAccount?: string | null;
    sentDay?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sent_emails
           (login, to_email, subject, status, message_id, thread_id, error,
            from_account, sent_day, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        entry.login,
        entry.toEmail,
        entry.subject ?? null,
        entry.status,
        entry.messageId ?? null,
        entry.threadId ?? null,
        entry.error ?? null,
        entry.fromAccount ?? null,
        entry.sentDay ?? null
      );
  }

  // --- Email account registry (drives the warm-up ramp & pausing) ---

  /** Register a sending account on first use; no-op if it already exists. */
  registerAccount(account: string): void {
    this.db
      .prepare(
        `INSERT INTO email_accounts (account, created_at) VALUES (?, datetime('now'))
         ON CONFLICT(account) DO NOTHING`
      )
      .run(account);
  }

  /** Whole days since the account was first registered (0 on its first day). */
  accountAgeDays(account: string): number {
    const row = this.db
      .prepare(
        `SELECT CAST(julianday('now') - julianday(created_at) AS INTEGER) AS days
         FROM email_accounts WHERE account = ?`
      )
      .get(account) as { days: number } | undefined;
    return Math.max(row?.days ?? 0, 0);
  }

  isAccountPaused(account: string): boolean {
    const row = this.db
      .prepare('SELECT paused FROM email_accounts WHERE account = ?')
      .get(account) as { paused: number } | undefined;
    return (row?.paused ?? 0) === 1;
  }

  setAccountPaused(account: string, paused: boolean): void {
    this.db
      .prepare('UPDATE email_accounts SET paused = ? WHERE account = ?')
      .run(paused ? 1 : 0, account);
  }

  /** Successful sends by this account on the given calendar day (UK date key). */
  sentCountOnDay(account: string, day: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM sent_emails
         WHERE status = 'sent' AND from_account = ? AND sent_day = ?`
      )
      .get(account, day) as { c: number };
    return row.c;
  }

  /** Every registered sending account (for the dashboard). */
  listEmailAccounts(): { account: string; created_at: string; paused: number }[] {
    return this.db
      .prepare('SELECT account, created_at, paused FROM email_accounts ORDER BY account')
      .all() as { account: string; created_at: string; paused: number }[];
  }

  /** Lifetime sent count + last-send time per account, keyed by account label. */
  accountAggregates(): Record<string, { totalSent: number; lastSent: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT from_account AS account, COUNT(*) AS total, MAX(sent_at) AS last
         FROM sent_emails WHERE status = 'sent' AND from_account IS NOT NULL
         GROUP BY from_account`
      )
      .all() as { account: string; total: number; last: string | null }[];
    const out: Record<string, { totalSent: number; lastSent: string | null }> = {};
    for (const r of rows) out[r.account] = { totalSent: r.total, lastSent: r.last };
    return out;
  }

  /** Global email totals: successes, errors, and recipients not yet sent to. */
  emailTotals(): { sent: number; error: number; unsent: number } {
    const sent = (
      this.db.prepare("SELECT COUNT(*) AS c FROM sent_emails WHERE status = 'sent'").get() as {
        c: number;
      }
    ).c;
    const error = (
      this.db.prepare("SELECT COUNT(*) AS c FROM sent_emails WHERE status = 'error'").get() as {
        c: number;
      }
    ).c;
    const unsent = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM users u
           WHERE u.email IS NOT NULL AND u.email <> ''
             AND NOT EXISTS (
               SELECT 1 FROM sent_emails s WHERE s.status = 'sent' AND s.to_email = u.email
             )
             AND NOT EXISTS (
               SELECT 1 FROM suppressions x WHERE x.email = lower(u.email)
             )`
        )
        .get() as { c: number }
    ).c;
    return { sent, error, unsent };
  }

  /** Most recent send attempts (success or error), newest first, for the activity feed. */
  recentSends(limit = 20): {
    login: string | null;
    to_email: string;
    subject: string | null;
    status: string;
    error: string | null;
    from_account: string | null;
    sent_at: string;
  }[] {
    return this.db
      .prepare(
        `SELECT login, to_email, subject, status, error, from_account, sent_at
         FROM sent_emails ORDER BY id DESC LIMIT ?`
      )
      .all(Math.min(Math.max(limit, 1), 100)) as {
      login: string | null;
      to_email: string;
      subject: string | null;
      status: string;
      error: string | null;
      from_account: string | null;
      sent_at: string;
    }[];
  }

  // --- Suppression list (do-not-email) ---

  /** True if this address is on the do-not-email list (case-insensitive). */
  isSuppressed(email: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM suppressions WHERE email = ? LIMIT 1')
      .get(email.trim().toLowerCase());
    return row !== undefined;
  }

  /** Add one address to the suppression list. Returns true if newly added. */
  addSuppression(email: string, reason = 'manual'): boolean {
    const addr = email.trim().toLowerCase();
    if (!addr) return false;
    const res = this.db
      .prepare(
        `INSERT INTO suppressions (email, reason, added_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(email) DO NOTHING`
      )
      .run(addr, reason);
    return res.changes > 0;
  }

  /** Add many addresses at once; returns how many were newly added. */
  addSuppressions(emails: string[], reason = 'manual'): number {
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const e of emails) if (this.addSuppression(e, reason)) added++;
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  /** Remove one address from the suppression list. Returns true if it existed. */
  removeSuppression(email: string): boolean {
    const res = this.db
      .prepare('DELETE FROM suppressions WHERE email = ?')
      .run(email.trim().toLowerCase());
    return res.changes > 0;
  }

  /** The suppression list, newest first (capped). */
  listSuppressions(limit = 200): { email: string; reason: string | null; added_at: string }[] {
    return this.db
      .prepare('SELECT email, reason, added_at FROM suppressions ORDER BY added_at DESC, email LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 1000)) as {
      email: string;
      reason: string | null;
      added_at: string;
    }[];
  }

  suppressionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM suppressions').get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }
}
