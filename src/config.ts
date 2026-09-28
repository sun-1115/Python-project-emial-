import 'dotenv/config';
import { getUsSearchLocations } from './location.js';

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
  crawlIntervalMinutes: number; // >0 = continuous loop; 0 = use cronSchedule instead

  // seed search
  locations: string[];
  languages: string[];
  minFollowers?: number;
  minRepos?: number;
  extra?: string;
  createdRanges: string[]; // e.g. ">=2022-01-01", "2015-01-01..2019-12-31"
  sort?: 'followers' | 'repositories' | 'joined';
  order: 'asc' | 'desc';
  maxSeedUsers: number;
  maxSeedsPerQuery: number; // >0 = take at most this many seeds per query slice

  // deep split (exhaustive per-facet coverage past GitHub's 1000/query cap)
  deepSplit: boolean;
  deepStartDate: string; // earliest account-creation date to sweep from
  createdBefore: string; // ONLY keep accounts created strictly before this date (exclusive)

  // crawl
  crawlEnabled: boolean;
  requireEmail: boolean; // only save users that have a discoverable email
  maxReposPerUser: number;
  maxContributorsPerRepo: number;
  maxTotalUsers: number;
  maxRepoSizeMb: number;

  // ui
  uiPort: number;
}

export function loadConfig(): AppConfig {
  const githubToken = process.env.GITHUB_TOKEN?.trim() ?? '';
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is not set. Add it to .env (see .env.example).');
  }

  // Locations: both SEARCH_LOCATIONS and SEARCH_LOCATION accept a comma list.
  // With SEARCH_ALL_US=true, also fold in every US state + city (from location.ts)
  // as search facets — hundreds of slices to beat the 1000-per-query cap.
  const locList = [...csv(process.env.SEARCH_LOCATIONS), ...csv(process.env.SEARCH_LOCATION)];
  const useAllUs = (process.env.SEARCH_ALL_US ?? '').toLowerCase() === 'true';
  const locations = useAllUs
    ? [...new Set([...getUsSearchLocations(), ...locList])]
    : locList.length > 0
      ? [...new Set(locList)]
      : DEFAULT_US_LOCATIONS;

  const languages = csv(process.env.SEARCH_LANGUAGE)
    .map((l) => l.toLowerCase())
    .filter((l) => VALID_LANGUAGES.has(l));

  return {
    githubToken,
    dbPath: process.env.DB_PATH?.trim() || './data/github-users.db',
    cronSchedule: process.env.CRON_SCHEDULE?.trim() || '0 3 * * *',
    runOnStart: (process.env.RUN_ON_START ?? 'true').toLowerCase() !== 'false',
    crawlIntervalMinutes: optNum(process.env.CRAWL_INTERVAL_MINUTES) ?? 30,

    locations,
    languages,
    minFollowers: optNum(process.env.SEARCH_MIN_FOLLOWERS),
    minRepos: optNum(process.env.SEARCH_MIN_REPOS),
    extra: process.env.SEARCH_EXTRA?.trim() || undefined,
    createdRanges: csv(process.env.SEARCH_CREATED_RANGES),
    sort: (process.env.SEARCH_SORT?.trim() as AppConfig['sort']) || undefined,
    order: (process.env.SEARCH_ORDER?.trim() as 'asc' | 'desc') || 'desc',
    maxSeedUsers: optNum(process.env.MAX_USERS) ?? 50,
    maxSeedsPerQuery: optNum(process.env.MAX_SEEDS_PER_QUERY) ?? 0,

    deepSplit: (process.env.DEEP_SPLIT ?? '').toLowerCase() === 'true',
    deepStartDate: process.env.DEEP_START_DATE?.trim() || '2008-01-01',
    // Only keep OLD accounts: created strictly before this date. Excludes new
    // (e.g. 2026) accounts that slip in via repo contributors.
    createdBefore: process.env.CREATED_BEFORE?.trim() || '2020-01-01',

    crawlEnabled: (process.env.CRAWL_ENABLED ?? 'true').toLowerCase() !== 'false',
    // Only keep users with a contactable email (pure contact list).
    requireEmail: (process.env.REQUIRE_EMAIL ?? 'true').toLowerCase() !== 'false',
    maxReposPerUser: optNum(process.env.MAX_REPOS_PER_USER) ?? 30,
    maxContributorsPerRepo: optNum(process.env.MAX_CONTRIBUTORS_PER_REPO) ?? 30,
    maxTotalUsers: optNum(process.env.MAX_TOTAL_USERS) ?? 1000,
    // Skip repos bigger than this (MB) — huge clones (Linux, etc.) can't list
    // contributors and waste ~10s each. 0 disables the check.
    maxRepoSizeMb: optNum(process.env.MAX_REPO_SIZE_MB) ?? 300,

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
  const ranges = cfg.createdRanges.length > 0 ? cfg.createdRanges : [undefined];
  const queries: string[] = [];
  for (const range of ranges) {
    for (const loc of cfg.locations) {
      for (const lang of langs) {
        const parts = [`location:"${loc}"`, ...base];
        if (lang) parts.push(`language:${lang}`);
        if (range) parts.push(`created:${range}`);
        queries.push(parts.join(' '));
      }
    }
  }
  return queries;
}

/**
 * Base facets for DEEP split: one query per (location × language), WITHOUT any
 * `created:` qualifier — the deep sweep supplies its own date windows.
 */
export function buildBaseFacets(cfg: AppConfig): string[] {
  const base: string[] = [];
  if (cfg.minFollowers !== undefined) base.push(`followers:>=${cfg.minFollowers}`);
  if (cfg.minRepos !== undefined) base.push(`repos:>=${cfg.minRepos}`);
  if (cfg.extra) base.push(cfg.extra);

  const langs = cfg.languages.length > 0 ? cfg.languages : [undefined];
  const facets: string[] = [];
  for (const loc of cfg.locations) {
    for (const lang of langs) {
      const parts = [`location:"${loc}"`, ...base];
      if (lang) parts.push(`language:${lang}`);
      facets.push(parts.join(' '));
    }
  }
  return facets;
}
