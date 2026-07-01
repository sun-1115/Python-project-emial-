import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UserRecord {
  login: string; // username — PRIMARY KEY
  github_id: number | null;
  name: string | null;
  avatar_url: string | null;
  html_url: string | null;
  company: string | null;
  location: string | null;
  email: string | null;
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

export interface PageOptions {
  q?: string;
  page?: number; // 1-based
  pageSize?: number;
  sort?: 'username' | 'followers';
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
    this.migrate();

    // Upsert by username. Keep first_seen_at and don't downgrade a 'search'
    // discovery to 'contributor' on later runs.
    this.upsertStmt = this.db.prepare(`
      INSERT INTO users (
        login, github_id, name, avatar_url, html_url, company, location, email,
        telegram, bio, blog, public_repos, followers, following, github_created_at,
        discovered_via, first_seen_at, last_fetched_at
      ) VALUES (
        :login, :github_id, :name, :avatar_url, :html_url, :company, :location, :email,
        :telegram, :bio, :blog, :public_repos, :followers, :following, :github_created_at,
        :discovered_via, datetime('now'), datetime('now')
      )
      ON CONFLICT(login) DO UPDATE SET
        github_id = excluded.github_id,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        html_url = excluded.html_url,
        company = excluded.company,
        location = excluded.location,
        email = excluded.email,
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
        login TEXT PRIMARY KEY,
        github_id INTEGER,
        name TEXT,
        avatar_url TEXT,
        html_url TEXT,
        company TEXT,
        location TEXT,
        email TEXT,
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
    `);

    // Add columns introduced after the first release, for existing databases.
    const cols = this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'telegram')) {
      this.db.exec('ALTER TABLE users ADD COLUMN telegram TEXT');
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

  /**
   * Page through users for the UI.
   * - sort 'username' uses keyset pagination on the login PK (scales to huge tables).
   * - sort 'followers' returns the top rows by follower count (single bounded query).
   */
  list(opts: ListOptions): UserRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
    const cols = `login, github_id, name, avatar_url, html_url, company, location,
                  email, telegram, bio, public_repos, followers, following, discovered_via`;
    const params: Record<string, string | number> = { limit };
    const where: string[] = [];

    if (opts.q) {
      where.push('(login LIKE :q OR name LIKE :q OR location LIKE :q)');
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
    const cols = `login, github_id, name, avatar_url, html_url, company, location,
                  email, telegram, bio, public_repos, followers, following, discovered_via`;

    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (opts.q) {
      where.push('(login LIKE :q OR name LIKE :q OR location LIKE :q)');
      params.q = `%${opts.q}%`;
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM users ${whereSql}`).get(params) as { c: number }
    ).c;

    const orderBy =
      opts.sort === 'followers'
        ? 'ORDER BY followers DESC NULLS LAST, login ASC'
        : 'ORDER BY login ASC';

    const rows = this.db
      .prepare(`SELECT ${cols} FROM users ${whereSql} ${orderBy} LIMIT :limit OFFSET :offset`)
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as unknown as UserRecord[];

    return { users: rows, total, page, pageSize, totalPages: Math.max(Math.ceil(total / pageSize), 1) };
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

  close(): void {
    this.db.close();
  }
}
