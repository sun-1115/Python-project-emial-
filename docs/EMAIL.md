# Email bot (Gmail API)

Sends plain-text emails to the users stored in your SQLite DB, using the Gmail
API with a **send-only** OAuth scope (`gmail.send`). Every send is logged to a
`sent_emails` table so runs are **idempotent** (no double-sends) and resumable.

## Files

| File | Purpose |
| --- | --- |
| `src/email/gmail.ts` | Reusable `sendEmail(to, subject, body, opts)` + OAuth + MIME builder |
| `scripts/email-auth.mjs` | One-time browser consent → writes `token.json` |
| `scripts/send-campaign.mjs` | The bot: reads unsent recipients from the DB and sends |
| `sent_emails` table | Audit log / idempotency (created automatically) |

## 1. Enable the Gmail API & create OAuth credentials

1. Go to <https://console.cloud.google.com/> → create (or pick) a project.
2. **APIs & Services → Library →** search "Gmail API" → **Enable**.
3. **APIs & Services → OAuth consent screen →** choose **External**, fill the app
   name/email, and under **Scopes** add `.../auth/gmail.send`. Add your own Gmail
   address under **Test users** (required while the app is in "Testing").
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID →**
   Application type **Desktop app** → **Create**.
5. **Download JSON**, save it as `credentials.json` in the project root
   (or copy `client_id`/`client_secret` into `.env` as
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).

`credentials.json` and `token.json` are git-ignored — never commit them.

## 2. First-time consent (once)

```bash
npm run build
npm run email:auth
```

It prints a URL. Open it, approve access with the Gmail account you added as a
test user, and Google redirects back to `http://localhost:5555`. This writes
`token.json`. After this the token auto-refreshes; you won't need to repeat it.

## 3. Send

Always dry-run first to see who would be contacted:

```bash
npm run build
node scripts/send-campaign.mjs --dry-run
```

Then send (start small):

```bash
node scripts/send-campaign.mjs --limit 20 --subject "Hi {{name}}" --body-file message.txt
```

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dry-run` | off | Preview recipients, send nothing |
| `--limit N` | 0 (all) | Send at most N this run |
| `--delay MS` | 1500 | Pause between sends (throttle) |
| `--subject S` | "Hello from GitHub Track" | Subject line |
| `--body-file F` | built-in | Read body template from a file |

The body template supports `{{name}}` and `{{login}}` placeholders, filled per
recipient. Recipients are `users` rows that have an email and no successful
`sent_emails` entry yet, ordered by id — so re-running continues where it left off.

> **Gmail limits:** a free @gmail.com account can send to roughly **500
> recipients/day**. Keep `--limit`/`--delay` conservative to avoid throttling or
> account flags. This is cold outreach — make sure it complies with anti-spam law
> (CAN-SPAM / GDPR) and include a way to opt out.

## Using the module directly

```js
import { sendEmail } from './dist/email/gmail.js';

const res = await sendEmail(
  'someone@example.com',
  'Subject line',
  'Plain text body.',
  { html: '<p>Optional HTML body.</p>', cc: 'cc@example.com' }
);
console.log(res.id, res.threadId);
```

`sendEmail` handles token refresh, base64url MIME encoding, and retries `429`/`5xx`
with exponential backoff.
