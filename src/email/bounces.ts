// Spot Gmail's "Message blocked" bounces. A block is NOT a send error: the API
// accepts the message and returns an id, then Google drops a bounce from
// mailer-daemon into the sender's inbox moments later. So the only way to see one
// is to read that inbox, which is what the gmail.readonly scope is for. The query
// only ever matches mailer-daemon, and nothing is modified.
// Wording of a reputation/content block. Deliberately excludes the ordinary
// "Address not found" bounce, which says nothing about the sending account.
const BLOCKED_RE = /message blocked|has been blocked|(appears|likely) suspicious|likely unsolicited/i;

/** True if a bounce's text describes a block rather than e.g. a dead address. */
export function isBlockedBounce(text: string): boolean {
  return BLOCKED_RE.test(text);
}

/** Minimal shape of a Gmail message part (recursive for multipart bounces). */
interface MessagePart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: MessagePart[] | null;
}

/** Decoded text/* content of a message, across all nested MIME parts. */
export function messageText(part: MessagePart | null | undefined): string {
  if (!part) return '';
  const own =
    part.mimeType?.startsWith('text/') && part.body?.data
      ? Buffer.from(part.body.data, 'base64url').toString('utf8')
      : '';
  return [own, ...(part.parts ?? []).map(messageText)].join('\n');
}

