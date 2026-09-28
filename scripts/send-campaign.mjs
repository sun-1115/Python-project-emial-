// Multi-account email bot. Rotates across every authorized Gmail account
// (tokens/token-*.json), enforces a per-account warm-up daily cap, only sends
// during EST business hours, and spaces each account's sends with human-like
// jitter. Idempotent (logs to sent_emails) and resumable.
//
//   npm run build
//   node scripts/send-campaign.mjs --dry-run           → preview plan, send nothing
//   node scripts/send-campaign.mjs                      → daemon (run under pm2)
//   node scripts/send-campaign.mjs --once               → one sweep, then exit (for cron)
//   node scripts/send-campaign.mjs --limit 50           → stop after 50 sends this run
//   node scripts/send-campaign.mjs --account alice      → only this account (testing)
//   node scripts/send-campaign.mjs --messages ./messages   → folder of templates (default)
//   node scripts/send-campaign.mjs --body-file msg.txt      → single template file
//   node scripts/send-campaign.mjs --subject "Hi {{name}}"  → default subject
//
// Messages: every .txt/.md file in the messages folder is a template; ONE is
// chosen at random per recipient. A file may start with a "Subject: ..." line to
// set its own subject. Templates support {{name}}, {{login}}, and {spin|tax}.
// An unsubscribe line is appended automatically unless the body says "unsubscribe".
import 'dotenv/config';
import { readFileSync } from 'node:fs';

import { load } from './_dist.mjs';

const { loadConfig } = await load('config.js');
const { UserStore } = await load('db.js');
const { runCampaign } = await load('email/campaign.js');
const { loadTemplates, parseTemplate } = await load('email/content.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const bodyFile = opt('--body-file', null);
const messagesDir = opt('--messages', process.env.EMAIL_MESSAGES_DIR?.trim() || './messages');
const defaultBody =
  'Hi {{name|there}},\n\n' +
  "{I came across|I stumbled on|I ran into} your GitHub profile (@{{login}}) and wanted to reach out.\n\n" +
  '{Best regards|Thanks|Cheers}.';

// Templates, in priority order:
//   1. --body-file <file>  → a single explicit template
//   2. the messages folder → every .txt/.md file, one picked at random per send
//   3. the built-in default template
let templates;
if (bodyFile) {
  templates = [parseTemplate(bodyFile, readFileSync(bodyFile, 'utf8'))];
} else {
  templates = loadTemplates(messagesDir);
  if (templates.length === 0) {
    console.warn(`No templates in ${messagesDir} — using the built-in default message.`);
    templates = [parseTemplate('default', defaultBody)];
  }
}

const opts = {
  templates,
  defaultSubject: opt('--subject', 'Hi {{name|there}}'),
  dryRun: flag('--dry-run'),
  once: flag('--once'),
  totalLimit: Number(opt('--limit', '0')) || 0,
  onlyAccount: opt('--account', null),
};

const cfg = loadConfig();
const store = new UserStore(cfg.dbPath);

// Stop the daemon cleanly on Ctrl-C so the DB closes and WAL checkpoints.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\nReceived ${sig}, shutting down…`);
    try { store.close(); } catch {}
    process.exit(0);
  });
}

try {
  await runCampaign(store, opts);
} finally {
  try { store.close(); } catch {}
}
