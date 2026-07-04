import cron from 'node-cron';
import { loadConfig } from './config.js';
import { runCrawl } from './crawler.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = loadConfig();

  // Single run then exit.
  if (once) {
    await runCrawl(config, 0);
    return;
  }

  // Continuous mode (default): crawl over and over, all day, no commands needed.
  // Each cycle rotates to a different search slice so it keeps finding new users.
  if (config.crawlIntervalMinutes > 0) {
    console.log(
      `Continuous crawl: a run, then ${config.crawlIntervalMinutes} min pause, forever. Ctrl+C to stop.`
    );
    for (let cycle = 0; ; cycle++) {
      try {
        await runCrawl(config, cycle);
      } catch (err) {
        console.error('Crawl cycle failed:', err instanceof Error ? err.message : err);
      }
      console.log(`Next crawl in ${config.crawlIntervalMinutes} min...`);
      await sleep(config.crawlIntervalMinutes * 60_000);
    }
  }

  // Fallback: fixed cron schedule (only if CRAWL_INTERVAL_MINUTES=0).
  if (config.runOnStart) {
    await runCrawl(config, 0).catch((err) => console.error('Initial crawl failed:', err));
  }
  if (!cron.validate(config.cronSchedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: "${config.cronSchedule}"`);
  }
  console.log(`Scheduled crawl with cron: ${config.cronSchedule}. Press Ctrl+C to stop.`);
  cron.schedule(config.cronSchedule, () => {
    runCrawl(config, 0).catch((err) => console.error('Scheduled crawl failed:', err));
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
