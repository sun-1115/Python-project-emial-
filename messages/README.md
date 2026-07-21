# Message templates

Every `.txt` / `.md` file in this folder is a message template. The bot picks
**one at random per recipient**, so your outreach isn't a single identical blast.

## Format

- An optional first line `Subject: ...` sets that template's subject. Without it,
  the campaign's `--subject` (default) is used.
- Everything after the subject line (and one blank line) is the body.
- Both subject and body support:
  - `{{name|there}}` — recipient's name, or `there` when they have no name
    (so the greeting reads "Hi Alex," or "Hi there,")
  - `{{name}}` — recipient's name (falls back to their login if you don't give a `|fallback`)
  - `{{firstName|there}}` — first name only (e.g. "Alex" from "Alex Kim")
  - `{{login}}` — GitHub username
  - `{option a|option b|option c}` — spintax; one option chosen at random

  The `|fallback` after any field is the text used when that field is empty.

Example:

```
Subject: Hi {{name|there}}

Hi {{name|there}},

{I came across|I ran into} your GitHub profile (@{{login}}) and wanted to reach out.

{Best|Thanks},
```

## Notes

- An unsubscribe line is appended automatically unless a template already
  contains the word "unsubscribe".
- Add or edit files freely — no rebuild needed; they're read at send time.
- Preview what will go out with:
  `node scripts/send-campaign.mjs --dry-run`
