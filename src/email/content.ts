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

/** Resolve one placeholder field to its raw value ('' when unknown/empty). */
function fieldValue(key: string, r: Recipient): string {
  switch (key.toLowerCase()) {
    case 'name':
      return r.name?.trim() || '';
    case 'firstname':
      return r.name?.trim().split(/\s+/)[0] || '';
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
 * login. A `|fallback` gives the text to use when the field is empty, e.g.
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

/**
 * Build the final body: personalized + spun template, with the unsubscribe
 * footer appended unless the template already contains "unsubscribe".
 */
export function buildBody(template: string, r: Recipient, unsubscribe = DEFAULT_UNSUBSCRIBE): string {
  const body = fillTemplate(template, r);
  const footer = spin(unsubscribe).trim();
  if (!footer || /unsubscribe/i.test(body)) return body;
  return `${body}\n\n${footer}`;
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
