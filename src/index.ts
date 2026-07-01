import cron from 'node-cron';
import { loadConfig } from './config.js';
import { runCrawl } from './crawler.js';

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = loadConfig();

  if (once) {
    await runCrawl(config);
    return;
  }

  if (config.runOnStart) {
    await runCrawl(config).catch((err) => console.error('Initial crawl failed:', err));
  }

  if (!cron.validate(config.cronSchedule)) {
    throw new Error(`Invalid CRON_SCHEDULE: "${config.cronSchedule}"`);
  }

  console.log(`Scheduled crawl with cron: ${config.cronSchedule}. Press Ctrl+C to stop.`);
  cron.schedule(config.cronSchedule, () => {
    runCrawl(config).catch((err) => console.error('Scheduled crawl failed:', err));
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
