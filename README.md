# Github Track

Discovers GitHub users and stores them in a local **SQLite** database, then lets you
browse them in a web UI. It starts from a USA-focused search, then **expands through
repositories** — for each user it looks at their non-fork repos and saves everyone who
contributed to them (the people they collaborate with).

## Stack
- Node.js **22.5+** (uses the built-in `node:sqlite` module — no native build step) + TypeScript (ES modules)
- [`@octokit/rest`](https://github.com/octokit/rest.js) + [`@octokit/plugin-throttling`](https://github.com/octokit/plugin-throttling.js) — GitHub API client with automatic rate-limit backoff
- [`node:sqlite`](https://nodejs.org/api/sqlite.html) — SQLite storage (first-party, zero dependencies)
- [`node-cron`](https://github.com/node-cron/node-cron) — scheduling
- [`express`](https://expressjs.com/) — the browsing UI

## Setup

```bash
npm install
cp .env.example .env   # then edit .env
```

Set `GITHUB_TOKEN` in `.env` (create one at https://github.com/settings/tokens;
`read:user` scope is enough). All other settings have sensible defaults — see
`.env.example` for every knob.

## Run

```bash
# Crawl once and exit (good for testing)
npm run crawl:once

# Crawl on the configured cron schedule (long-running process)
npm run dev

# Browse the collected users in your browser
npm run ui        # then open http://localhost:3000
```

## How it works
1. **Seed search.** Builds a faceted list of GitHub searches — one per
   `location × language` (see `buildQueries` in `src/config.ts`). Faceting beats
   GitHub's 1,000-results-per-query cap and covers the whole US broadly.
2. **Repository expansion (1 hop).** For each seed user it lists their **non-fork**
   repositories, then each repo's **contributors** — the other users they collaborate
   with. Forks are skipped. It does *not* then crawl those contributors' repos (no recursion).
3. **Save USA + unknown-location users.** Every discovered user — seeds *and*
   contributors — is upserted into the single `users` table (keyed by username),
   **but only if their location is empty or looks like the USA**; clearly-foreign
   locations are dropped (see `isUsOrEmpty` in `src/location.ts`). `discovered_via`
   records whether a user came from `search` or as a `contributor`. Rate limits are
   handled automatically; hard caps (`MAX_*`) keep a run bounded.

## Data model — one `users` table
Keyed by `login` (username). Columns include `avatar_url`, `name`, `location`,
`followers`, `following`, `public_repos`, `html_url`, `bio`, `company`,
`discovered_via`, `first_seen_at`, `last_fetched_at`.

Inspect it directly:
```bash
sqlite3 data/github-users.db "SELECT login, followers, location FROM users ORDER BY followers DESC LIMIT 10;"
```

## The UI
`npm run ui` serves a single-page grid at `http://localhost:3000`:
avatar cards with username, name, location and follower count, a search box
(username / name / location), sort by A–Z or most followers, and infinite scroll.
It's built for large tables: the API returns one page at a time
(keyset pagination on the username index), never the whole table.
