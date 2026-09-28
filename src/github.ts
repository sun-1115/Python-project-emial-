import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import type { UserRecord } from './db.js';

const ThrottledOctokit = Octokit.plugin(throttling);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for transient network / server errors that are worth retrying. */
export function isTransient(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string };
  const status = e?.status;
  if (status && [408, 429, 500, 502, 503, 504, 522, 524].includes(status)) return true;
  const code = (e?.code ?? '').toString().toLowerCase();
  const msg = (e?.message ?? '').toString().toLowerCase();
  const netCodes = ['enotfound', 'econnrefused', 'econnreset', 'etimedout', 'eai_again', 'epipe', 'esockettimedout'];
  if (netCodes.some((c) => code === c || msg.includes(c))) return true;
  return ['fetch failed', 'network', 'socket hang up', 'timeout', 'request failed', 'getaddrinfo']
    .some((s) => msg.includes(s));
}

/**
 * Run an async GitHub call, retrying transient network failures with exponential
 * backoff. Non-transient errors (e.g. 404, 422) are thrown immediately. This lets
 * a short disconnect self-heal instead of aborting the crawl.
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt > retries || !isTransient(err)) throw err;
      console.warn(
        `Network issue on ${label} (attempt ${attempt}/${retries}); retrying in ${delay}ms: ${(err as Error).message}`
      );
      await sleep(delay);
      delay *= 2;
    }
  }
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** A real, contactable email — not a GitHub privacy proxy or a placeholder. */
export function isUsableEmail(email?: string | null): email is string {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return false;
  if (e.includes('noreply') || e.includes('no-reply')) return false; // GitHub proxy etc.
  if (e.endsWith('.local') || e.endsWith('.localhost') || e.endsWith('.internal')) return false;
  if (e.includes('example.com') || e.includes('users.noreply')) return false;
  return true;
}

/** First usable email found in free text (bio, blog, mailto:…), or null. */
export function extractEmail(text?: string | null): string | null {
  if (!text) return null;
  const m = text.match(EMAIL_RE);
  return m && isUsableEmail(m[0]) ? m[0] : null;
}

/** Pull a normalized https://t.me/<handle> link out of arbitrary text, if present. */
export function extractTelegram(text?: string | null): string | null {
  if (!text) return null;
  // t.me / telegram.me / telegram.dog links
  const url = text.match(/(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(\+?[A-Za-z0-9_]{3,})/i);
  if (url) return `https://t.me/${url[1]}`;
  // "telegram: @handle" or "tg: @handle"
  const handle = text.match(/(?:telegram|tg)\s*[:@]\s*@?([A-Za-z0-9_]{4,})/i);
  if (handle) return `https://t.me/${handle[1]}`;
  return null;
}

// --- date helpers for the deep-split date sweep (YYYY-MM-DD strings) ---
const DAY_MS = 86_400_000;
const toMs = (d: string) => Date.parse(d + 'T00:00:00Z');
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDay = (d: string) => fmtDate(toMs(d) + DAY_MS);
const midDate = (a: string, b: string) => fmtDate(toMs(a) + Math.floor((toMs(b) - toMs(a)) / 2));
const cmpDate = (a: string, b: string) => toMs(a) - toMs(b);

// Follower ranges to break apart a single day that still exceeds 1000 users.
const FOLLOWER_BUCKETS = [
  '0..0', '1..2', '3..5', '6..10', '11..25', '26..50', '51..100',
  '101..250', '251..500', '501..1000', '1001..5000', '>5000',
];

export interface DeepResult {
  logins: string[];
  nextDate: string | null; // where the sweep stopped (null = facet fully swept)
  leaves: number;
}

export interface RepoRef {
  owner: string;
  name: string;
  fork: boolean;
}

/** Raw public-profile fields — the cheap first fetch, before email/telegram enrichment. */
export interface Profile {
  login: string;
  github_id: number | null;
  name: string | null;
  avatar_url: string | null;
  html_url: string | null;
  company: string | null;
  location: string | null;
  profileEmail: string | null;
  bio: string | null;
  blog: string | null;
  public_repos: number | null;
  followers: number | null;
  following: number | null;
  github_created_at: string | null;
}

export class GitHubClient {
  private octokit: InstanceType<typeof ThrottledOctokit>;

  constructor(token: string) {
    this.octokit = new ThrottledOctokit({
      auth: token,
      throttle: {
        // Automatically wait out primary rate limits (retry up to twice).
        onRateLimit: (retryAfter, options, _octokit, retryCount) => {
          console.warn(
            `Rate limit hit for ${options.method} ${options.url}; retrying in ${retryAfter}s`
          );
          return retryCount < 2;
        },
        // Secondary (abuse) limits: back off once.
        onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
          console.warn(
            `Secondary rate limit for ${options.method} ${options.url}; retrying in ${retryAfter}s`
          );
          return retryCount < 1;
        },
      },
    });
  }

  /** Search users for one query, returning up to `max` logins. */
  async searchUserLogins(
    query: string,
    max: number,
    sort?: 'followers' | 'repositories' | 'joined',
    order: 'asc' | 'desc' = 'desc'
  ): Promise<string[]> {
    const perPage = 100;
    const cap = Math.min(max, 1000); // GitHub search hard cap
    const maxPage = Math.ceil(1000 / perPage); // GitHub returns only the first 1000 results
    const logins: string[] = [];
    for (let page = 1; logins.length < cap && page <= maxPage; page++) {
      let res;
      try {
        res = await withRetry(
          () => this.octokit.rest.search.users({ q: query, sort, order, per_page: perPage, page }),
          `search page ${page}`
        );
      } catch (err) {
        // e.g. 422 past the 1000-result window, or a transient search error — stop this query.
        console.warn(`Search stopped for "${query}" at page ${page}: ${(err as Error).message}`);
        break;
      }
      for (const item of res.data.items) {
        if (logins.length >= cap) break;
        if (item.type === 'User') logins.push(item.login);
      }
      if (res.data.items.length < perPage) break;
    }
    return logins;
  }

  /** One search request → the User logins on that page plus the total match count. */
  private async searchOnce(
    q: string,
    page: number,
    perPage: number,
    sort?: 'followers' | 'repositories' | 'joined',
    order: 'asc' | 'desc' = 'desc'
  ): Promise<{ logins: string[]; total: number; items: number }> {
    const res = await withRetry(
      () => this.octokit.rest.search.users({ q, sort, order, per_page: perPage, page }),
      `search "${q}" p${page}`
    );
    const logins = res.data.items.filter((i) => i.type === 'User').map((i) => i.login);
    return { logins, total: res.data.total_count, items: res.data.items.length };
  }

  /** Page a single query fully (bounded by GitHub's 1000-result window). */
  private async pageLeaf(
    q: string,
    sort?: 'followers' | 'repositories' | 'joined',
    order: 'asc' | 'desc' = 'desc'
  ): Promise<string[]> {
    const perPage = 100;
    const out: string[] = [];
    for (let page = 1; out.length < 1000 && page <= 10; page++) {
      const { logins, items } = await this.searchOnce(q, page, perPage, sort, order);
      out.push(...logins);
      if (items < perPage) break;
    }
    return out;
  }

  /**
   * Exhaustively collect logins for one facet (e.g. `location:"Texas" language:go`)
   * by sweeping account-creation date windows. Each window is shrunk until its
   * total_count ≤ 1000 so it can be paged completely; a single day that still
   * exceeds 1000 is broken apart by follower buckets.
   *
   * Returns up to (roughly) `maxCollect` logins and a `nextDate` cursor so the
   * caller can resume this facet on a later cycle instead of re-covering it.
   */
  async searchUsersDeep(
    facet: string,
    startFrom: string,
    endDate: string,
    opts: {
      sort?: 'followers' | 'repositories' | 'joined';
      order?: 'asc' | 'desc';
      maxCollect: number;
    }
  ): Promise<DeepResult> {
    const { sort, order = 'desc', maxCollect } = opts;
    const seen = new Set<string>();
    const collected: string[] = [];
    const add = (arr: string[]) => {
      for (const l of arr) if (!seen.has(l)) { seen.add(l); collected.push(l); }
    };

    let cur = startFrom;
    let leaves = 0;
    while (cmpDate(cur, endDate) <= 0 && collected.length < maxCollect) {
      // Shrink [cur, hi] until it holds ≤ 1000 users (or collapses to one day).
      let hi = endDate;
      let { total } = await this.searchOnce(`${facet} created:${cur}..${hi}`, 1, 1, sort, order);
      let guard = 0;
      while (total > 1000 && cmpDate(cur, hi) < 0 && guard++ < 40) {
        hi = midDate(cur, hi);
        ({ total } = await this.searchOnce(`${facet} created:${cur}..${hi}`, 1, 1, sort, order));
      }

      if (total === 0) {
        cur = addDay(hi);
        continue;
      }
      if (total > 1000 && cmpDate(cur, hi) === 0) {
        // Single day, still too big → split by follower buckets.
        for (const b of FOLLOWER_BUCKETS) {
          add(await this.pageLeaf(`${facet} created:${cur}..${cur} followers:${b}`, sort, order));
        }
      } else {
        add(await this.pageLeaf(`${facet} created:${cur}..${hi}`, sort, order));
      }
      leaves++;
      cur = addDay(hi);
    }

    const nextDate = cmpDate(cur, endDate) <= 0 ? cur : null;
    return { logins: collected, nextDate, leaves };
  }

  /**
   * Fetch just the public profile (one API call). The crawler runs its cheap
   * date/location filters on this BEFORE the extra email/telegram lookups, so we
   * don't waste API calls enriching users we're about to drop.
   */
  async getProfile(login: string): Promise<Profile> {
    const { data } = await withRetry(
      () => this.octokit.rest.users.getByUsername({ username: login }),
      `getUser ${login}`
    );
    return {
      login: data.login,
      github_id: data.id ?? null,
      name: data.name ?? null,
      avatar_url: data.avatar_url ?? null,
      html_url: data.html_url ?? null,
      company: data.company ?? null,
      location: data.location ?? null,
      profileEmail: data.email ?? null,
      bio: data.bio ?? null,
      blog: data.blog ?? null,
      public_repos: data.public_repos ?? null,
      followers: data.followers ?? null,
      following: data.following ?? null,
      github_created_at: data.created_at ?? null,
    };
  }

  /**
   * Complete a fetched profile into a full UserRecord: resolve the email
   * (profile → commit → bio) and Telegram handle. Costs 1-2 extra API calls, so
   * only call it for users that already passed the cheap filters.
   */
  async buildRecord(
    profile: Profile,
    discoveredVia: UserRecord['discovered_via']
  ): Promise<UserRecord> {
    const telegram = await this.findTelegram(profile.login, profile.blog, profile.bio);
    const { email, source } = await this.resolveEmail(
      profile.login,
      profile.profileEmail,
      profile.blog,
      profile.bio
    );
    return {
      login: profile.login,
      github_id: profile.github_id,
      name: profile.name,
      avatar_url: profile.avatar_url,
      html_url: profile.html_url,
      company: profile.company,
      location: profile.location,
      email,
      email_source: source,
      telegram,
      bio: profile.bio,
      blog: profile.blog,
      public_repos: profile.public_repos,
      followers: profile.followers,
      following: profile.following,
      github_created_at: profile.github_created_at,
      discovered_via: discoveredVia,
    };
  }

  /** Fetch a full user profile and map it to a UserRecord (profile + enrichment). */
  async getUser(login: string, discoveredVia: UserRecord['discovered_via']): Promise<UserRecord> {
    const profile = await this.getProfile(login);
    return this.buildRecord(profile, discoveredVia);
  }

  /**
   * Best-effort email with a trust-ordered fallback chain:
   *   1. public profile email        (most reliable — the user published it)
   *   2. commit author email          (mined from public PushEvents)
   *   3. email found in blog / bio    (mailto: or raw address)
   * GitHub privacy-proxy (`…@users.noreply.github.com`) and placeholder
   * addresses are always skipped. Returns the email and where it came from.
   */
  async resolveEmail(
    login: string,
    profileEmail?: string | null,
    blog?: string | null,
    bio?: string | null
  ): Promise<{ email: string | null; source: string | null }> {
    if (isUsableEmail(profileEmail)) return { email: profileEmail.trim(), source: 'profile' };

    const commit = await this.mineCommitEmail(login);
    if (commit) return { email: commit, source: 'commit' };

    const scraped = extractEmail(blog) ?? extractEmail(bio);
    if (scraped) return { email: scraped, source: 'bio' };

    return { email: null, source: null };
  }

  /** Public-profile fetch used by the email backfill (profile + fallback chain). */
  async getEmail(login: string): Promise<{ email: string | null; source: string | null }> {
    const { data } = await withRetry(
      () => this.octokit.rest.users.getByUsername({ username: login }),
      `getEmail ${login}`
    );
    return this.resolveEmail(login, data.email, data.blog, data.bio);
  }

  /**
   * Mine commit author emails from the user's own (non-fork) repos and return
   * the most frequently used usable one. This is the reliable email source: the
   * Events API no longer includes commit details, but `GET /repos/…/commits?
   * author={login}` exposes the author email on each of their commits. Skips
   * GitHub's `…@users.noreply.github.com` proxy addresses. ~2-3 core API calls.
   */
  private async mineCommitEmail(login: string): Promise<string | null> {
    try {
      const repos = await this.listUserRepos(login, 3, 0); // top 3 non-fork repos
      const counts = new Map<string, number>();
      for (const r of repos) {
        let res;
        try {
          res = await withRetry(
            () =>
              this.octokit.rest.repos.listCommits({
                owner: r.owner,
                repo: r.name,
                author: login,
                per_page: 10,
              }),
            `commits ${r.owner}/${r.name}`
          );
        } catch {
          continue; // empty repo, etc. — try the next one
        }
        for (const c of res.data) {
          // Ownership check: only trust the email when GitHub has linked THIS
          // commit to the target account (c.author.login === login). GitHub links
          // a commit to an account by matching the author email to one registered
          // on it — so a match proves the email belongs to @login, not a co-author.
          if (c.author?.login?.toLowerCase() !== login.toLowerCase()) continue;
          const em = c.commit?.author?.email;
          if (isUsableEmail(em)) counts.set(em, (counts.get(em) ?? 0) + 1);
        }
        if (counts.size) break; // found usable email(s) here — no need to scan more repos
      }
      let best: string | null = null;
      let bestN = 0;
      for (const [em, n] of counts) {
        if (n > bestN) {
          best = em;
          bestN = n;
        }
      }
      return best;
    } catch {
      return null; // user has no usable repos / all commits are proxy addresses
    }
  }

  /**
   * Best-effort Telegram handle. GitHub has no telegram field, so we look in the
   * user's blog/bio and their linked social accounts for a t.me / telegram link.
   */
  private async findTelegram(
    login: string,
    blog?: string | null,
    bio?: string | null
  ): Promise<string | null> {
    const fromProfile = extractTelegram(blog) ?? extractTelegram(bio);
    if (fromProfile) return fromProfile;
    try {
      const { data } = await this.octokit.rest.users.listSocialAccountsForUser({
        username: login,
      });
      for (const acc of data) {
        const t = extractTelegram(acc.url);
        if (t) return t;
      }
    } catch {
      /* social accounts endpoint unavailable — ignore */
    }
    return null;
  }

  /**
   * List a user's own repositories, EXCLUDING forks and repos larger than
   * `maxSizeMb` MB (0 = no size limit), up to `max`.
   */
  async listUserRepos(login: string, max: number, maxSizeMb = 0): Promise<RepoRef[]> {
    const repos: RepoRef[] = [];
    const perPage = 100;
    const maxSizeKb = maxSizeMb > 0 ? maxSizeMb * 1024 : 0; // GitHub reports repo size in KB
    for (let page = 1; repos.length < max; page++) {
      const res = await withRetry(
        () => this.octokit.rest.repos.listForUser({
          username: login, type: 'owner', per_page: perPage, page, sort: 'pushed',
        }),
        `listUserRepos ${login} page ${page}`
      );
      for (const r of res.data) {
        if (r.fork) continue; // skip forks (per requirement)
        if (maxSizeKb && (r.size ?? 0) > maxSizeKb) continue; // skip huge clones
        repos.push({ owner: r.owner.login, name: r.name, fork: false });
        if (repos.length >= max) break;
      }
      if (res.data.length < perPage) break;
    }
    return repos;
  }

  /** List logins of human contributors to a repo, up to `max`. */
  async listRepoContributors(owner: string, repo: string, max: number): Promise<string[]> {
    const logins: string[] = [];
    const perPage = 100;
    try {
      for (let page = 1; logins.length < max; page++) {
        const res = await withRetry(
          () => this.octokit.rest.repos.listContributors({
            owner, repo, per_page: perPage, page, anon: 'false',
          }),
          `listContributors ${owner}/${repo} page ${page}`
        );
        for (const c of res.data) {
          if (c.type === 'User' && c.login) logins.push(c.login);
          if (logins.length >= max) break;
        }
        if (res.data.length < perPage) break;
      }
    } catch (err) {
      // Empty repos (204) or huge-history repos (403) — just skip.
      console.warn(`Skipping contributors for ${owner}/${repo}: ${(err as Error).message}`);
    }
    return logins;
  }
}
