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

export interface RepoRef {
  owner: string;
  name: string;
  fork: boolean;
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

  /** Fetch a full user profile and map it to a UserRecord. */
  async getUser(login: string, discoveredVia: UserRecord['discovered_via']): Promise<UserRecord> {
    const { data } = await withRetry(
      () => this.octokit.rest.users.getByUsername({ username: login }),
      `getUser ${login}`
    );
    const telegram = await this.findTelegram(login, data.blog, data.bio);
    return {
      login: data.login,
      github_id: data.id ?? null,
      name: data.name ?? null,
      avatar_url: data.avatar_url ?? null,
      html_url: data.html_url ?? null,
      company: data.company ?? null,
      location: data.location ?? null,
      email: data.email ?? null,
      telegram,
      bio: data.bio ?? null,
      blog: data.blog ?? null,
      public_repos: data.public_repos ?? null,
      followers: data.followers ?? null,
      following: data.following ?? null,
      github_created_at: data.created_at ?? null,
      discovered_via: discoveredVia,
    };
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

  /** List a user's own repositories, EXCLUDING forks, up to `max`. */
  async listUserRepos(login: string, max: number): Promise<RepoRef[]> {
    const repos: RepoRef[] = [];
    const perPage = 100;
    for (let page = 1; repos.length < max; page++) {
      const res = await withRetry(
        () => this.octokit.rest.repos.listForUser({
          username: login, type: 'owner', per_page: perPage, page, sort: 'pushed',
        }),
        `listUserRepos ${login} page ${page}`
      );
      for (const r of res.data) {
        if (r.fork) continue; // skip forks (per requirement)
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
