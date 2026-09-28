// One-time Gmail consent for ONE account. Run once per account to create its
// token file (tokens/token-<label>.json):
//   npm run build
//   npm run email:auth -- --account alice
//   npm run email:auth -- --account bob --port 5556
// Requires credentials.json (OAuth Desktop client) OR GOOGLE_CLIENT_ID/SECRET in .env.
import 'dotenv/config';

import { load } from './_dist.mjs';

const { runConsentFlow } = await load('email/gmail.js');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const account = opt('--account', null);
const port = Number(opt('--port', '5555')) || 5555;

if (!account) {
  console.error(
    'Missing --account <label>. Name it after the Gmail account so you can tell them apart, e.g.:\n' +
      '  npm run email:auth -- --account expertdev1111\n'
  );
  process.exit(1);
}

await runConsentFlow(account, port);
