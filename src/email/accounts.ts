// Multi-account discovery. Each Gmail account has its own OAuth token file under
// EMAIL_TOKENS_DIR, named token-<label>.json. The <label> is the account's
// stable identity used everywhere: for rotation, per-account daily caps, and the
// from_account audit column in sent_emails.
//
// Authorize each account once:  npm run email:auth -- --account <label>
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const TOKENS_DIR = process.env.EMAIL_TOKENS_DIR?.trim() || './tokens';

/** A single sending identity: a label plus the token file backing it. */
export interface Account {
  label: string;
  tokenPath: string;
}

/**
 * Every authorized account, sorted by label for a stable rotation order.
 * Falls back to a legacy single ./token.json (label "default") so an existing
 * one-account setup keeps working without re-authorizing.
 */
export function discoverAccounts(): Account[] {
  const accounts: Account[] = [];
  if (existsSync(TOKENS_DIR)) {
    for (const file of readdirSync(TOKENS_DIR)) {
      const m = /^token-(.+)\.json$/.exec(file);
      if (m) accounts.push({ label: m[1], tokenPath: join(TOKENS_DIR, file) });
    }
  }
  if (accounts.length === 0) {
    const legacy = process.env.GMAIL_TOKEN_PATH?.trim() || './token.json';
    if (existsSync(legacy)) accounts.push({ label: 'default', tokenPath: legacy });
  }
  return accounts.sort((a, b) => a.label.localeCompare(b.label));
}
