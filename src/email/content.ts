// Message construction. Two anti-spam concerns handled here:
//   1. Variation  — a folder of message templates (one picked at random per
//      recipient), plus {{placeholders}} and {spin|tax} so no two messages are
//      byte-identical (identical bulk text is the loudest spam signal).
//   2. Opt-out    — every message MUST carry a working unsubscribe line, both for
//      compliance (CAN-SPAM / GDPR) and sender reputation.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface Recipient {
  login: string;
  email: string;
  name: string | null;
}

/** Default opt-out footer. On consumer Gmail we can't host a link, so we invite
 *  a reply — which you MUST honor by suppressing that address. */
export const DEFAULT_UNSUBSCRIBE =
  process.env.EMAIL_UNSUBSCRIBE_TEXT?.trim() ||
  "";

/** Resolve {a|b|c} spintax by picking one option at random, recursively. */
export function spin(text: string): string {
  const re = /\{([^{}]*)\}/; // innermost group with no nested braces
  let out = text;
  let guard = 0;
  while (re.test(out) && guard++ < 1000) {
    out = out.replace(re, (_m, body: string) => {
      const opts = body.split('|');
      return opts[Math.floor(Math.random() * opts.length)];
    });
  }
  return out;
}

// --- Name hygiene -----------------------------------------------------------
// GitHub's "name" field is free text, so it arrives full of things you must not
// greet someone with: honorifics, credentials, nicknames in parentheses, emoji,
// job titles, company names, handles. "Hi Elizabeth (Liz) A. O'Gorman, Ph.D."
// reads as a mail merge; "Hi Elizabeth" reads as a person. cleanName() reduces a
// profile name to a greetable one, and returns '' when the value isn't a human
// name at all — the caller then falls back to `{{name|there}}`.

const TITLE_RE = /^(dr|mr|mrs|ms|miss|mx|prof|professor|sir|madam|rev|fr|capt|lt|sgt)\.?$/i;
const SUFFIX_RE =
  /^(ph\.?d|d\.?phil|m\.?d|d\.?d\.?s|d\.?v\.?m|jr|snr|sr|ii|iii|iv|v|esq|mba|m\.?sc|m\.?s|m\.?a|b\.?sc|b\.?s|b\.?a|pmp|cpa|cfa|rn|np|do|jd|ed\.?d|psy\.?d|p\.?e|pe|cissp|ocp|mcse)\.?$/i;
// Words that mean the value is a company / role / label rather than a person.
const NON_NAME_RE =
  /\b(inc|llc|ltd|limited|gmbh|s\.?a|b\.?v|n\.?v|corp|corporation|company|holdings|group|team|labs?|studio|software|technolog\w*|solutions?|systems?|services?|consulting|agency|media|digital|official|bot|dev|devs|developer|engineer|engineering|programmer|designer|freelancer|founder|ceo|cto|cofounder|student|university|college|school|institute|foundation|community|network|opensource|admin|support|hire|hiring)\b/i;

/** Title-case a token while preserving intentional inner caps (McRae, DeSoto). */
function fixCase(token: string): string {
  const hasInnerCaps = /[a-z][A-Z]/.test(token);
  if (hasInnerCaps) return token; // McRae, DeSoto — leave alone
  const lower = token.toLowerCase();
  // Capitalize after the start and after each apostrophe / hyphen: o'gorman → O'Gorman.
  return lower.replace(/(^|['’\-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * Reduce a raw profile name to a name you can safely greet someone with, or ''
 * when it doesn't look like a personal name.
 *
 *   "Elizabeth (Liz) A. O'Gorman, Ph.D." → "Elizabeth O'Gorman"
 *   "Dr. JOHN SMITH JR."                 → "John Smith"
 *   "sun wu | Software Engineer"         → "Sun Wu"
 *   "Acme Labs", "🚀", "me@x.com", "x1"  → ""
 */
export function cleanName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).normalize('NFC');
  s = s.replace(/[\p{Extended_Pictographic}\p{So}\p{Sk}]/gu, ' '); // emoji / symbols
  // A tagline after a separator ("Name | Title", "Name @ Co") is not part of the name.
  s = s.split(/\s*[|/\\·•—–]\s*|\s+@\s*|\s+[-–]\s+/)[0];
  s = s.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|"[^"]*"|“[^”]*”/g, ' '); // (Liz), "Liz"
  s = s.replace(/,/g, ' ');

  let tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length && TITLE_RE.test(tokens[0])) tokens.shift(); // Dr. Prof.
  while (tokens.length && SUFFIX_RE.test(tokens[tokens.length - 1])) tokens.pop(); // Ph.D. Jr.
  // Middle initials ("A." / "A") add nothing to a greeting.
  tokens = tokens.filter((t, i) => !(i > 0 && i < tokens.length - 1 && /^\p{L}\.?$/u.test(t)));

  // A role/company word tacked onto a name ("John Doe CTO") ends the name; the
  // same word at the very start means the whole value is a label, not a person.
  const label = tokens.findIndex((t) => NON_NAME_RE.test(t));
  if (label >= 0) tokens = label >= 2 ? tokens.slice(0, label) : [];

  if (tokens.length === 0 || tokens.length > 4) return '';
  // Every token must be a word: letters plus the punctuation real names use.
  // This alone rejects emails, URLs, handles and anything with digits.
  const isWord = (t: string) => /^\p{L}[\p{L}\p{M}'’.-]*$/u.test(t);
  if (!tokens.every(isWord)) return '';

  const joined = tokens.join(' ');
  if (joined.replace(/[^\p{L}]/gu, '').length < 2) return ''; // "X", "A."
  if (joined.length > 40) return '';

  return tokens.map(fixCase).join(' ');
}

/** Resolve one placeholder field to its raw value ('' when unknown/empty). */
function fieldValue(key: string, r: Recipient): string {
  switch (key.toLowerCase()) {
    case 'name':
      return cleanName(r.name);
    case 'firstname':
      return cleanName(r.name).split(' ')[0] || '';
    case 'login':
      return r.login;
    default:
      return '';
  }
}

// {{ key }} or {{ key | fallback }} — fallback is used when the field is empty.
const FIELD_RE = /\{\{\s*([a-zA-Z]+)\s*(?:\|([^}]*))?\}\}/g;

/**
 * Fill placeholders, then resolve spintax. Supported fields: name, firstName,
 * login. `name`/`firstName` are passed through cleanName(), so an unusable
 * profile name ("Acme Labs", "🚀", an email address) counts as empty and takes
 * the fallback. A `|fallback` gives the text to use when the field is empty, e.g.
 * `{{name|there}}` → the name, or "there" for recipients with no name. Without a
 * fallback, `{{name}}` falls back to the login (kept for backward compatibility).
 */
export function fillTemplate(template: string, r: Recipient): string {
  const filled = template.replace(FIELD_RE, (_m, key: string, fallback?: string) => {
    const value = fieldValue(key, r);
    if (value) return value;
    if (fallback !== undefined) return fallback;
    return key.toLowerCase() === 'name' ? r.login : '';
  });
  return spin(filled);
}

/** Greeting prepended to every message at send time, so the templates stay
 *  greeting-free. Override with EMAIL_GREETING (set it empty to disable). */
export const DEFAULT_GREETING =
  process.env.EMAIL_GREETING ?? 'Hi {{name|there}},';

/** True if the text already opens with a greeting — don't add a second one. */
const HAS_GREETING_RE = /^\s*(hi|hello|hey|dear|greetings|good\s+(morning|afternoon|evening))\b/i;

/**
 * Build the final body: greeting + personalized/spun template, with the
 * unsubscribe footer appended unless the template already contains
 * "unsubscribe".
 */
export function buildBody(
  template: string,
  r: Recipient,
  unsubscribe = DEFAULT_UNSUBSCRIBE,
  greeting = DEFAULT_GREETING
): string {
  let body = fillTemplate(template, r);
  const hello = fillTemplate(greeting, r).trim();
  if (hello && !HAS_GREETING_RE.test(body)) body = `${hello}\n\n${body}`;
  const footer = spin(unsubscribe).trim();
  if (!footer || /unsubscribe/i.test(body)) return body;
  return `${body}\n\n${footer}`;
}

// --- HTML rendering ---------------------------------------------------------
// Sent as text/plain only, Gmail renders the message in its plain-text style: a
// narrow fixed-width column with hard wraps mid-sentence. Pairing the same text
// with a text/html part makes it render like a normal email — proper paragraphs
// that reflow to the reader's window. The markup is deliberately minimal
// (paragraphs + one inline font rule); image-heavy or table-based HTML is a
// spam signal, and clients that prefer plain text still get the text part.

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** Render the plain-text body as simple HTML: blank line = paragraph, single
 *  newline = line break. Escapes everything — templates are plain text. */
export function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `  <p style="margin:0 0 14px;">${escapeHtml(block).split('\n').join('<br>')}</p>`)
    .join('\n');
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;' +
    'line-height:1.6;color:#202124;">\n' +
    paragraphs +
    '\n</div>'
  );
}

// --- Message templates (a folder of variants, one chosen at random per send) ---

export interface Template {
  name: string; // source filename, for logging
  subject?: string; // optional per-template subject (from a leading "Subject:" line)
  body: string;
}

/**
 * Parse one template file. An optional first line "Subject: ..." sets a
 * per-template subject; the rest (after an optional blank line) is the body.
 * Both subject and body may use {{placeholders}} and {spin|tax}.
 */
export function parseTemplate(name: string, raw: string): Template {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let subject: string | undefined;
  let start = 0;
  if (lines[0] && /^subject:/i.test(lines[0].trim())) {
    subject = lines[0].replace(/^\s*subject:\s*/i, '').trim();
    start = lines[1] === '' ? 2 : 1; // skip a blank line after the header
  }
  return { name, subject, body: lines.slice(start).join('\n').trim() };
}

/**
 * Load every message template from a folder (.txt / .md files). Returns [] if
 * the folder is missing or empty, so the caller can fall back to a default.
 */
export function loadTemplates(dir: string): Template[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const templates: Template[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/\.(txt|md)$/i.test(file)) continue;
    if (/^(readme|_)/i.test(file)) continue; // skip docs / disabled templates
    const raw = readFileSync(join(dir, file), 'utf8');
    const t = parseTemplate(basename(file), raw);
    if (t.body.trim()) templates.push(t);
  }
  return templates;
}

/** Pick one template at random (uniform). */
export function pickTemplate(templates: Template[]): Template {
  return templates[Math.floor(Math.random() * templates.length)];
}
