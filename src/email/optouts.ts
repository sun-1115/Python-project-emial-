// Honor opt-out replies. Every campaign message invites a reply of "unsubscribe"
// (and its List-Unsubscribe header mails the same request), so the requests land in
// the sending account's inbox. Replies quote the original message, footer included,
// so only the text the person actually wrote may count. Nothing is modified.
const OPT_OUT_RE =
  /\bunsubscribe\b|\bremove me\b|\btake me off\b|\bopt(ing)?[ -]out\b|\bstop (emailing|contacting|sending|messaging)\b|\bdo not (email|contact)\b|\bdon['’]t (email|contact)\b/i;

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

