// Honor opt-out replies. Every campaign message invites a reply of "unsubscribe"
// (and its List-Unsubscribe header mails the same request), so the requests land in
// the sending account's inbox. Replies quote the original message, footer included,
// so only the text the person actually wrote may count. Nothing is modified.
import { google } from 'googleapis';
import type { getAuthorizedClient } from './gmail.js';

type OAuthClient = ReturnType<typeof getAuthorizedClient>;

const OPT_OUT_RE =
  /\bunsubscribe\b|\bremove me\b|\btake me off\b|\bopt(ing)?[ -]out\b|\bstop (emailing|contacting|sending|messaging)\b|\bdo not (email|contact)\b|\bdon['’]t (email|contact)\b/i;

// Finds candidates; isOptOut() makes the actual decision.
const SEARCH =
  '{unsubscribe "remove me" "take me off" "opt out" "stop emailing" "stop contacting" "stop sending" "do not email" "do not contact"}';

/** How far back to look. Re-reading is harmless: suppressing twice changes nothing. */
const LOOKBACK_DAYS = 30;

/** What the person wrote in a plain-text reply, without the message it quotes. */
export function replyText(plain: string): string {
  const text = plain.replace(/\r\n/g, '\n');
  // "On <date>, <name> wrote:" can wrap over two lines; Outlook starts with "From:".
  const quoteStart = text.search(/^(On\b[\s\S]{0,200}?wrote:\s*$|From:\s|-{2,}\s*Original Message|_{5,})/m);
  const own = quoteStart >= 0 ? text.slice(0, quoteStart) : text;
  return own
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');
}

/** Same as replyText for a reply that has only an HTML part. */
export function htmlReplyText(html: string): string {
  const quoteStart = html.search(/gmail_quote|<blockquote|yahoo_quoted|divRplyFwdMsg|<hr\b/i);
  const own = quoteStart >= 0 ? html.slice(0, quoteStart) : html;
  return replyText(own.replace(/<[^>]*>/g, ' '));
}

/** Did the person ask to stop, in the subject or in their own words? */
export function isOptOut(subject: string, ownText: string): boolean {
  return OPT_OUT_RE.test(subject) || OPT_OUT_RE.test(ownText);
}

/** The bare address from a From header: `Jane <jane@x.com>` → `jane@x.com`. */
export function senderAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

/** Minimal shape of a Gmail message part (recursive for multipart messages). */
interface MessagePart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: MessagePart[] | null;
}

/** Decoded content of the first part of this type, searching nested parts. */
function partText(part: MessagePart | null | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const child of part.parts ?? []) {
    const found = partText(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Addresses asking to stop, among messages from people this campaign has emailed.
 * `isOurRecipient` runs on the headers alone, so unrelated mail is never opened:
 * newsletters in the inbox say "unsubscribe" too, and they are not opt-outs.
 */
export async function findOptOuts(
  auth: OAuthClient,
  isOurRecipient: (address: string) => boolean
): Promise<string[]> {
  const gmail = google.gmail({ version: 'v1', auth });
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `${SEARCH} newer_than:${LOOKBACK_DAYS}d -from:mailer-daemon -from:me`,
    includeSpamTrash: true,
    maxResults: 100,
  });

  const optOuts = new Set<string>();
  for (const { id } of list.data.messages ?? []) {
    if (!id) continue;
    const { data: head } = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject'],
    });
    const header = (name: string) =>
      head.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
    const address = senderAddress(header('from'));
    if (optOuts.has(address) || !isOurRecipient(address)) continue;

    const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const plain = partText(data.payload, 'text/plain');
    const html = partText(data.payload, 'text/html');
    const own = plain !== null ? replyText(plain) : html !== null ? htmlReplyText(html) : '';
    if (isOptOut(header('subject'), own)) optOuts.add(address);
  }
  return [...optOuts];
}
