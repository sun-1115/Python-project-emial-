import type { AppConfig } from './config.js';
import { buildQueries, buildBaseFacets } from './config.js';
import { GitHubClient } from './github.js';
import { UserStore } from './db.js';
import { isUsOrEmpty } from './location.js';

/** Fast/breadth seeding: sample a few seeds from many location×language×era slices. */
async function facetedSeed(
  config: AppConfig,
  client: GitHubClient,
  cycle: number,
  stamp: () => string
): Promise<Set<string>> {
  const allQueries = buildQueries(config);
  // Advance the window by how many slices a cycle consumes, so successive cycles
  // cover fresh slices instead of overlapping.
  const slicesPerCycle =
    config.maxSeedsPerQuery > 0
      ? Math.max(1, Math.ceil(config.maxSeedUsers / config.maxSeedsPerQuery))
      : 1;
  const offset = allQueries.length ? (cycle * slicesPerCycle) % allQueries.length : 0;
  const queries = [...allQueries.slice(offset), ...allQueries.slice(0, offset)];
  console.log(
    `[${stamp()}] Cycle ${cycle}: faceted seeding from ${queries.length} slices (starting at #${offset})...`
  );

  const seeds = new Set<string>();
  for (const q of queries) {
    if (seeds.size >= config.maxSeedUsers) break;
    const remaining = config.maxSeedUsers - seeds.size;
    const take =
      config.maxSeedsPerQuery > 0 ? Math.min(config.maxSeedsPerQuery, remaining) : remaining;
    const logins = await client.searchUserLogins(q, take, config.sort, config.order);
    for (const l of logins) seeds.add(l);
  }
  return seeds;
}

/**
 * Deep/exhaustive seeding: walk location×language facets, sweeping account-creation
 * date windows so EVERY user in a facet is reachable (past the 1000/query cap).
 * A persistent cursor (facet index + date) resumes across cycles.
 */
async function deepSeed(
  config: AppConfig,
  client: GitHubClient,
  store: UserStore,
  stamp: () => string
): Promise<Set<string>> {
  const facets = buildBaseFacets(config);
  // Sweep only up to the cutoff, so the search never returns accounts newer than it.
  const endDate = config.createdBefore;
  const seeds = new Set<string>();

  let idx = Number(store.getState('deep_facet_idx') ?? '0');
  if (!Number.isFinite(idx) || idx < 0) idx = 0;
  let dateCursor = store.getState('deep_date_cursor') || config.deepStartDate;

  console.log(
    `[${stamp()}] Deep seeding from facet #${idx}/${facets.length} at ${dateCursor}...`
  );

  let visited = 0;
  while (seeds.size < config.maxSeedUsers && visited < facets.length) {
    const facet = facets[idx % facets.length];
    const remaining = config.maxSeedUsers - seeds.size;
    const { logins, nextDate } = await client.searchUsersDeep(facet, dateCursor, endDate, {
      sort: config.sort,
      order: config.order,
      maxCollect: remaining,
    });
    for (const l of logins) seeds.add(l);

    if (nextDate === null) {
      idx = (idx + 1) % facets.length; // facet fully swept → next facet
      dateCursor = config.deepStartDate;
      visited++;
    } else {
      dateCursor = nextDate; // more of this facet remains → resume here next time
    }
    store.setState('deep_facet_idx', String(idx));
    store.setState('deep_date_cursor', dateCursor);
  }
  return seeds;
}

/**
 * One crawl run:
 *   1. Faceted USA search (location × language) → seed usernames.
 *   2. For each seed: list non-fork repos → list each repo's contributors.
 *   3. Save EVERY discovered user (seed + contributor), any/no location.
 * No recursion: we never crawl the contributors' own repositories.
 */
export async function runCrawl(config: AppConfig, cycle = 0): Promise<void> {
  const client = new GitHubClient(config.githubToken);
  const store = new UserStore(config.dbPath);
  const stamp = () => new Date().toISOString();
  const seen = new Set<string>(); // logins whose profile we've fetched this run
  let saved = 0;

  const saveUser = async (
    login: string,
    via: 'search' | 'contributor'
  ): Promise<boolean> => {
    if (seen.has(login)) return false;
    if (saved >= config.maxTotalUsers) return false;
    seen.add(login);
    try {
      // Cheap fetch first (1 call) so we can drop by date/location BEFORE the
      // more expensive email/telegram enrichment.
      const profile = await client.getProfile(login);

      // Keep only OLD accounts: created strictly before the cutoff. Drops new
      // accounts (e.g. 2026) that slip in via repo contributors. An unknown
      // creation date is also dropped (can't prove it's old).
      const created = profile.github_created_at;
      if (!created || created.slice(0, 10) >= config.createdBefore) return false;
      // Keep only users with no location or a USA location; drop foreign ones.
      if (!isUsOrEmpty(profile.location)) return false;

      // Now enrich (resolve email + telegram) and require a contactable email.
      const user = await client.buildRecord(profile, via);
      if (config.requireEmail && !user.email) return false;

      store.upsert(user);
      saved++;
      return true;
    } catch (err) {
      console.warn(`Failed to fetch ${login}: ${(err as Error).message}`);
      return false;
    }
  };

  try {
    // --- 1. Seed search (USA) ---
    const seeds = config.deepSplit
      ? await deepSeed(config, client, store, stamp)
      : await facetedSeed(config, client, cycle, stamp);
    console.log(`[${stamp()}] Found ${seeds.size} seed users.`);

    // --- 2 + 3. Crawl each seed's repos → contributors, saving everyone ---
    for (const seed of seeds) {
      if (saved >= config.maxTotalUsers) break;
      await saveUser(seed, 'search');

      if (!config.crawlEnabled) continue;

      // A failure here (e.g. the network dropped and retries were exhausted) skips
      // this seed's repos rather than aborting the whole crawl.
      let repos;
      try {
        repos = await client.listUserRepos(seed, config.maxReposPerUser, config.maxRepoSizeMb);
      } catch (err) {
        console.warn(`Skipping repos for ${seed}: ${(err as Error).message}`);
        continue;
      }
      for (const repo of repos) {
        if (saved >= config.maxTotalUsers) break;
        const contributors = await client.listRepoContributors(
          repo.owner,
          repo.name,
          config.maxContributorsPerRepo
        );
        for (const login of contributors) {
          if (saved >= config.maxTotalUsers) break;
          await saveUser(login, 'contributor');
        }
      }
    }

    console.log(
      `[${stamp()}] Run complete. Saved/updated ${saved} users this run. ` +
        `Total in DB: ${store.count()}.`
    );
  } finally {
    store.close();
  }
}
