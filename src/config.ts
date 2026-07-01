import 'dotenv/config';

function optNum(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** GitHub `language:` qualifiers we accept. Anything else in .env is dropped. */
const VALID_LANGUAGES = new Set([
  'javascript', 'typescript', 'python', 'ruby', 'go', 'java', 'php', 'c', 'c++',
  'c#', 'swift', 'kotlin', 'rust', 'scala', 'dart', 'elixir', 'haskell', 'perl',
  'r', 'shell', 'objective-c', 'html', 'css', 'lua', 'clojure', 'erlang',
]);

/** Default USA location variants (free-text field, so we cast a wide net). */
const DEFAULT_US_LOCATIONS = [
  'United States', 'USA', 'US', 'California', 'New York', 'Texas', 'Washington',
  'Massachusetts', 'Illinois', 'Florida', 'San Francisco', 'Seattle', 'Los Angeles',
  'Boston', 'Chicago', 'Austin', 'New York City', 'Portland', 'Denver', 'Atlanta',
];

export interface AppConfig {
  githubToken: string;
  dbPath: string;
  cronSchedule: string;
  runOnStart: boolean;

  // seed search
  locations: string[];
  languages: string[];
  minFollowers?: number;
  minRepos?: number;
  extra?: string;
  sort?: 'followers' | 'repositories' | 'joined';
  order: 'asc' | 'desc';
  maxSeedUsers: number;

  // crawl
  crawlEnabled: boolean;
  maxReposPerUser: number;
  maxContributorsPerRepo: number;
  maxTotalUsers: number;

  // ui
  uiPort: number;
}

export function loadConfig(): AppConfig {
  const githubToken = process.env.GITHUB_TOKEN?.trim() ?? '';
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is not set. Add it to .env (see .env.example).');
  }

  // Locations: both SEARCH_LOCATIONS and SEARCH_LOCATION accept a comma list.
  // They're merged (deduped); if neither is set, fall back to the US defaults.
  const locList = [...csv(process.env.SEARCH_LOCATIONS), ...csv(process.env.SEARCH_LOCATION)];
  const locations = locList.length > 0 ? [...new Set(locList)] : DEFAULT_US_LOCATIONS;

  const languages = csv(process.env.SEARCH_LANGUAGE)
    .map((l) => l.toLowerCase())
    .filter((l) => VALID_LANGUAGES.has(l));

  return {
    githubToken,
    dbPath: process.env.DB_PATH?.trim() || './data/github-users.db',
    cronSchedule: process.env.CRON_SCHEDULE?.trim() || '0 3 * * *',
    runOnStart: (process.env.RUN_ON_START ?? 'true').toLowerCase() !== 'false',

    locations,
    languages,
    minFollowers: optNum(process.env.SEARCH_MIN_FOLLOWERS),
    minRepos: optNum(process.env.SEARCH_MIN_REPOS),
    extra: process.env.SEARCH_EXTRA?.trim() || undefined,
    sort: (process.env.SEARCH_SORT?.trim() as AppConfig['sort']) || undefined,
    order: (process.env.SEARCH_ORDER?.trim() as 'asc' | 'desc') || 'desc',
    maxSeedUsers: optNum(process.env.MAX_USERS) ?? 50,

    crawlEnabled: (process.env.CRAWL_ENABLED ?? 'true').toLowerCase() !== 'false',
    maxReposPerUser: optNum(process.env.MAX_REPOS_PER_USER) ?? 30,
    maxContributorsPerRepo: optNum(process.env.MAX_CONTRIBUTORS_PER_REPO) ?? 30,
    maxTotalUsers: optNum(process.env.MAX_TOTAL_USERS) ?? 1000,

    uiPort: optNum(process.env.UI_PORT) ?? 3000,
  };
}

/**
 * Build the faceted list of GitHub user-search queries.
 * One query per (location × language) so each returns up to GitHub's 1000-result
 * cap — faceting is how we exceed that cap and cover the whole US broadly.
 */
export function buildQueries(cfg: AppConfig): string[] {
  const base: string[] = [];
  if (cfg.minFollowers !== undefined) base.push(`followers:>=${cfg.minFollowers}`);
  if (cfg.minRepos !== undefined) base.push(`repos:>=${cfg.minRepos}`);
  if (cfg.extra) base.push(cfg.extra);

  const langs = cfg.languages.length > 0 ? cfg.languages : [undefined];
  const queries: string[] = [];
  for (const loc of cfg.locations) {
    for (const lang of langs) {
      const parts = [`location:"${loc}"`, ...base];
      if (lang) parts.push(`language:${lang}`);
      queries.push(parts.join(' '));
    }
  }
  return queries;
}
