// Reputation warm-up: the sending accounts email EACH OTHER on a daily rotation,
// so every account both SENDS one message and RECEIVES exactly one — building
// sending history and inter-account familiarity. Reuses the campaign's send
// primitive (getAuthorizedClient + sendEmail); no separate sending stack.
//
// Addresses come from EMAIL_WARMUP_ADDRESSES (comma / space / newline separated).
// Each address is paired to its authorized account (token file) by normalizing
// the label and the address local-part, so token-coding-ninja714.json matches
// coding.ninja714@gmail.com automatically. When a label is only a shortened form
// of the local-part (token-khushi50211.json ↔ khushi50211.11@gmail.com) the
// prefix pass catches it; write "label=address" in EMAIL_WARMUP_ADDRESSES to pin
// a pairing explicitly. Anything left unpaired is logged, never dropped quietly.
import { getAuthorizedClient, sendEmail } from './gmail.js';
import { discoverAccounts } from './accounts.js';
import { fillTemplate, spin, type Recipient, type Template } from './content.js';

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${stamp()}] [warmup] ${msg}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface WarmupPeer {
  label: string;
  tokenPath: string;
  address: string;
}

/** Lowercase + strip non-alphanumerics, so "coding-ninja714" == "coding.ninja714". */
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Normalized local-part of an address, with any Gmail "+tag" suffix dropped. */
const localOf = (address: string): string => normalize(address.split('@')[0].split('+')[0]);

/** One EMAIL_WARMUP_ADDRESSES entry: a bare address, or "label=address". */
interface WarmupEntry {
  address: string;
  /** Set only for "label=address" entries — pins the address to that token label. */
  pinnedLabel?: string;
}

function warmupEntries(): WarmupEntry[] {
  return (process.env.EMAIL_WARMUP_ADDRESSES || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'))
    .map((raw) => {
      const eq = raw.indexOf('=');
      if (eq > 0) {
        const pinnedLabel = raw.slice(0, eq).trim();
        const address = raw.slice(eq + 1).trim();
        if (pinnedLabel && address.includes('@')) return { address, pinnedLabel };
      }
      return { address: raw };
    });
}

/** Addresses configured for warm-up (EMAIL_WARMUP_ADDRESSES). */
export function warmupAddresses(): string[] {
  return warmupEntries().map((e) => e.address);
}

/**
 * Participants = accounts that have BOTH an authorized token file AND a
 * configured address. Pairing runs in three passes, each only over what is still
 * unclaimed, so a stricter match always wins over a looser one:
 *
 *   1. explicit "label=address" pins;
 *   2. exact normalized label == local-part;
 *   3. one is a prefix of the other (token-khushi50211 ↔ khushi50211.11), taken
 *      only when exactly one candidate remains on both sides — an ambiguous
 *      prefix is left unpaired rather than guessed at.
 *
 * Sorted by label for a stable rotation order.
 */
export function warmupPeers(): WarmupPeer[] {
  const accounts = discoverAccounts();
  const entries = warmupEntries();
  const peers: WarmupPeer[] = [];
  const freeAccounts = new Set(accounts);
  const freeEntries = new Set(entries);

  const claim = (acct: (typeof accounts)[number], entry: WarmupEntry) => {
    peers.push({ label: acct.label, tokenPath: acct.tokenPath, address: entry.address });
    freeAccounts.delete(acct);
    freeEntries.delete(entry);
  };

  // 1. Explicit pins.
  for (const entry of [...freeEntries]) {
    if (!entry.pinnedLabel) continue;
    const acct = [...freeAccounts].find((a) => normalize(a.label) === normalize(entry.pinnedLabel!));
    if (acct) claim(acct, entry);
    else log(`  ! "${entry.pinnedLabel}=${entry.address}": no token-${entry.pinnedLabel}.json found.`);
  }

  // 2. Exact normalized match.
  for (const entry of [...freeEntries]) {
    const acct = [...freeAccounts].find((a) => normalize(a.label) === localOf(entry.address));
    if (acct) claim(acct, entry);
  }

  // 3. Prefix match, only when unambiguous in both directions.
  for (const entry of [...freeEntries]) {
    const local = localOf(entry.address);
    const cands = [...freeAccounts].filter((a) => {
      const label = normalize(a.label);
      return label.startsWith(local) || local.startsWith(label);
    });
    if (cands.length !== 1) continue;
    const acct = cands[0];
    // Symmetric check: that account must not prefix-match another free address.
    const back = [...freeEntries].filter((e) => {
      const l = localOf(e.address);
      const label = normalize(acct.label);
      return label.startsWith(l) || l.startsWith(label);
    });
    if (back.length !== 1) continue;
    claim(acct, entry);
    log(`  ~ paired ${entry.address} → token-${acct.label}.json (prefix match).`);
  }

  for (const entry of freeEntries) {
    log(`  ! ${entry.address} has no authorized token file — it will not send or receive.`);
  }
  for (const acct of freeAccounts) {
    log(`  ! token-${acct.label}.json has no address in EMAIL_WARMUP_ADDRESSES — sitting out.`);
  }

  return peers.sort((a, b) => a.label.localeCompare(b.label));
}

export interface WarmupOptions {
  /** The campaign's own message templates (messages/01–06). When present these
   *  are what the accounts send each other, so warm-up traffic looks exactly
   *  like real traffic to the filters. */
  templates?: Template[];
  /** Subject used for templates that carry no leading "Subject:" line. */
  defaultSubject?: string;
}

/** Fallback subject when neither the template nor the caller supplies one. */
const FALLBACK_SUBJECT = 'Hi {{name|there}}';

// Fallback set, used only when messages/ is empty or unreadable. {spin|tax}
// keeps them from being byte-identical across accounts and days (identical bulk
// text is a spam signal).
const WARMUP_MESSAGES: { subject: string; body: string }[] = [
  { subject: '{Quick|Small} question', body: 'Hey,\n\n{Do you have|Got} a minute {this week|tomorrow}? Wanted to run something by you.\n\n{Thanks|Cheers}' },
  { subject: '{Following up|Circling back}', body: 'Hi,\n\nJust {following up|checking in} on {that|the} thing from earlier. {No rush|Whenever you get a sec}.\n\n{Best|Thanks}' },
  { subject: 'Notes from {today|the call}', body: 'Hey,\n\nJotting down what we {talked about|covered} so we don\'t lose it. {Talk soon|More later}.\n\n{Cheers|Thanks}' },
  { subject: 'That {link|article} I mentioned', body: 'Hi,\n\nHere\'s the {link|thing} I {mentioned|promised} — {take a look when you can|let me know what you think}.\n\n{Best|Cheers}' },
  { subject: 'Coffee {next week|soon}?', body: 'Hey,\n\n{Fancy|Up for} a coffee {next week|one of these days}? {Would be good to catch up|It\'s been a while}.\n\n{Cheers|Talk soon}' },
];

/** The receiving peer, shaped as a Recipient so templates can use {{name}} /
 *  {{login}} the same way they do in the campaign. */
function asRecipient(peer: WarmupPeer): Recipient {
  return { login: peer.address.split('@')[0], email: peer.address, name: null };
}

/**
 * Build one warm-up message. With templates loaded from messages/, rotate
 * through them by `seed` so a round covers different origin messages; each is
 * personalized to the recipient and spun, exactly like a campaign send. Falls
 * back to the built-in short notes only when no templates are available.
 */
function pickMessage(
  seed: number,
  to: WarmupPeer,
  opts: WarmupOptions,
): { subject: string; body: string; source: string } {
  const templates = opts.templates ?? [];
  if (templates.length > 0) {
    const t = templates[seed % templates.length];
    const r = asRecipient(to);
    const subject = t.subject || opts.defaultSubject?.trim() || FALLBACK_SUBJECT;
    return { subject: fillTemplate(subject, r), body: fillTemplate(t.body, r), source: t.name };
  }
  const m = WARMUP_MESSAGES[seed % WARMUP_MESSAGES.length];
  return { subject: spin(m.subject), body: spin(m.body), source: 'built-in' };
}

/**
 * Run one warm-up round: with `offset` in [1, n-1], peer i sends to peer
 * (i+offset) mod n. Every peer sends exactly one message and receives exactly
 * one. Sends are spaced by a short jitter and each uses its own client. These
 * are NOT logged to sent_emails (kept separate from campaign stats/caps).
 * Never throws — a failed account is logged and the round continues.
 */
export async function runWarmupRound(
  offset: number,
  opts: WarmupOptions = {},
): Promise<{ sent: number; failed: number; total: number }> {
  const peers = warmupPeers();
  const n = peers.length;
  if (n < 2) {
    log(`Need at least 2 configured accounts to warm up (have ${n}). Skipping.`);
    return { sent: 0, failed: 0, total: n };
  }
  const off = ((offset % n) + n) % n || 1; // keep in [1, n-1] — never 0 (no self-send)
  const nTemplates = opts.templates?.length ?? 0;
  log(
    `Round starting: ${n} accounts, offset ${off} (each sends 1, receives 1), ` +
      `${nTemplates > 0 ? `${nTemplates} message template(s)` : 'built-in messages'}.`,
  );
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < n; i++) {
    const from = peers[i];
    const to = peers[(i + off) % n];
    const { subject, body, source } = pickMessage(i + off, to, opts);
    try {
      const auth = getAuthorizedClient(from.tokenPath);
      await sendEmail(to.address, subject, body, { auth });
      sent++;
      log(`  ✓ ${from.address} → ${to.address} [${source}]`);
    } catch (err) {
      failed++;
      log(`  ✗ ${from.address} → ${to.address}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (i < n - 1) await sleep(30_000 + Math.floor(Math.random() * 60_000)); // 30–90s gap
  }
  log(`Round done: ${sent} sent, ${failed} failed.`);
  return { sent, failed, total: n };
}
