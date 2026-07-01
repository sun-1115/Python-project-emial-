import type { AppConfig } from './config.js';
import { buildQueries } from './config.js';
import { GitHubClient } from './github.js';
import { UserStore } from './db.js';
import { isUsOrEmpty } from './location.js';

/**
 * One crawl run:
 *   1. Faceted USA search (location × language) → seed usernames.
 *   2. For each seed: list non-fork repos → list each repo's contributors.
 *   3. Save EVERY discovered user (seed + contributor), any/no location.
 * No recursion: we never crawl the contributors' own repositories.
 */
export async function runCrawl(config: AppConfig): Promise<void> {
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
      const user = await client.getUser(login, via);
      // Keep only users with no location or a USA location; drop foreign ones.
      if (!isUsOrEmpty(user.location)) return false;
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
    const queries = buildQueries(config);
    console.log(`[${stamp()}] Seeding from ${queries.length} search quer${queries.length === 1 ? 'y' : 'ies'}...`);
    const seedLogins = new Set<string>();
    for (const q of queries) {
      if (seedLogins.size >= config.maxSeedUsers) break;
      const remaining = config.maxSeedUsers - seedLogins.size;
      const logins = await client.searchUserLogins(q, remaining, config.sort, config.order);
      for (const l of logins) seedLogins.add(l);
    }
    console.log(`[${stamp()}] Found ${seedLogins.size} seed users.`);

    // --- 2 + 3. Crawl each seed's repos → contributors, saving everyone ---
    for (const seed of seedLogins) {
      if (saved >= config.maxTotalUsers) break;
      await saveUser(seed, 'search');

      if (!config.crawlEnabled) continue;

      // A failure here (e.g. the network dropped and retries were exhausted) skips
      // this seed's repos rather than aborting the whole crawl.
      let repos;
      try {
        repos = await client.listUserRepos(seed, config.maxReposPerUser);
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
