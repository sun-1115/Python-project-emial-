# Email bot (Gmail API, multi-account)

Sends outreach to unsent users in the SQLite DB across up to 10 Gmail accounts,
imitating human behavior to protect deliverability and reduce ban risk.

## What it does

- **Rotation** across every authorized account (`tokens/token-<label>.json`).
- **Warm-up ramp** per account: 5 → 10 → 15 → 20 emails/day over ~4 weeks, then holds.
- **UK business-hours window** only (Mon–Fri, 9am–6pm by default).
- **Human-like pacing**: 15–30 min randomized gap per account, occasional longer breaks,
  daily counts that vary a little (never exactly the cap).
- **Unique content**: a `messages/` folder of templates (one picked at random per
  recipient) + `{{name}}`/`{{login}}` personalization + `{spin|tax}` variation.
- **Unsubscribe line** appended to every message automatically.
- **Idempotent & auditable**: each send logged to `sent_emails` with `from_account`;
  nobody is emailed twice, and a run resumes where it left off.
- **Do-not-email list**: suppressed addresses (opt-outs, bounces) are never sent to.
- **Dashboard** at `/email.html`: window status, per-account caps/usage, pause/resume,
  recent activity, and the suppression list.

## One-time setup

1. Create an OAuth **Desktop** client in Google Cloud (Gmail API enabled). Put its
   `client_id`/`client_secret` in `.env` (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`)
   or drop `credentials.json` in the project root.
2. Build, then authorize each account once (opens a URL to approve):
   ```
   npm run build
   npm run email:auth -- --account alice
   npm run email:auth -- --account bob
   ...                                  # once per account (10 total)
   ```
   Each writes `tokens/token-<label>.json`.

> **Consumer-Gmail caveat:** while your OAuth app is in "Testing" mode, refresh
> tokens expire after 7 days. Add each sending account as a **Test user** on the
> consent screen, and consider publishing the app so tokens persist.

Check account health anytime (verifies each token can still refresh):
```
npm run email:accounts
```
It flags `✗ BROKEN` (expired/revoked — re-run `email:auth`) and `⚠ no refresh_token`,
and shows each account's warm-up cap, today's usage, and lifetime sends.

## Messages

Put one or more templates in `messages/` (`.txt` or `.md`). The bot picks **one at
random per recipient**. A template may start with a `Subject: ...` line to set its
own subject. All support `{{name}}`, `{{login}}`, and `{spin|tax}`. See
[messages/README.md](../messages/README.md). Override the folder with `--messages <dir>`
or a single file with `--body-file <file>`.

## Running from the UI (recommended)

The send loop is embedded in the UI server, so you run **one** background process
and control everything from the dashboard.

```
npm run build
npm run serve            # starts the UI + embedded campaign (foreground)
```
Open `http://localhost:<UI_PORT>/email.html` and use the **Start sending / Stop
sending** button in the header. The state persists: if the server restarts, it
resumes whatever you last chose (Start stays on, Stop stays off).

Run it in the background so it survives logout/reboot (pm2):
```
pm2 start dist/server.js --name github-track
pm2 save
```
Now the bot runs 24/7 in the background; Start/Stop from the dashboard controls
sending, and the daily caps + UK window still apply. Stopping the loop leaves
the UI up — it just halts sending within ~1 second.

The messages folder and default subject used by the UI loop come from
`EMAIL_MESSAGES_DIR` and `EMAIL_SUBJECT` in `.env`.

## Running from the CLI

The standalone runner is still available (useful for `--dry-run`, `--once`, and
one-off tests):

```
node scripts/send-campaign.mjs --dry-run          # preview the plan, send nothing
node scripts/send-campaign.mjs --once             # one sweep (for cron)
node scripts/send-campaign.mjs                     # daemon — run under pm2
node scripts/send-campaign.mjs --limit 50          # stop after 50 sends this run
node scripts/send-campaign.mjs --account alice     # single account (testing)
node scripts/send-campaign.mjs --subject "Hi {{name}}" --body-file msg.txt
```

- **Daemon** (default): long-lived; sends continuously within the window, sleeps
  outside it, idles when nothing is left. Best under pm2.
- **`--once`**: sends one email per eligible account and exits; let your cron
  interval provide the spacing.

## Tuning

All knobs live in `.env` (see `.env.example`): timezone, window hours/days,
`EMAIL_DAILY_CAP`, gap minutes, unsubscribe text.

## Operational notes

- **Pause a degrading account** without losing history:
  `UPDATE email_accounts SET paused = 1 WHERE account = 'alice';`
- **Honor opt-outs** via the **Do-not-email list** on the Email dashboard
  (`/email.html`): paste any address that replies "unsubscribe" (plus hard
  bounces) and the campaign will never send to it again. Send-only scope can't
  read replies, so scan each inbox and add opt-outs there.
- **You are blind to bounces/complaints** with send-only scope + consumer Gmail.
  Watch for accounts that suddenly throw send errors — the bot auto-pauses an
  account for the day when Gmail signals a sending limit.
- **List quality matters most.** Verify addresses before sending; high bounce or
  complaint rates will sink accounts faster than any pacing trick can save them.
