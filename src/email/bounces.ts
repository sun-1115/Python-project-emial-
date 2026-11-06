// Spot Gmail's "Message blocked" bounces. A block is NOT a send error: the API
// accepts the message and returns an id, then Google drops a bounce from
// mailer-daemon into the sender's inbox moments later. So the only way to see one
// is to read that inbox, which is what the gmail.readonly scope is for. The query
// only ever matches mailer-daemon, and nothing is modified.
import { google } from 'googleapis';
import type { getAuthorizedClient } from './gmail.js';

type OAuthClient = ReturnType<typeof getAuthorizedClient>;

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

export interface BlockedBounce {
  at: number; // when the bounce arrived (epoch ms)
  recipient: string | null; // the address the blocked message was going to
}

/**
 * Check one mailbox for a block newer than `sinceMs`, returning the newest one.
 * Other bounces are ignored, whatever their age: a bounce can land 30+ minutes
 * after the timestamp it carries, so only a block the caller has acted on may
 * move `sinceMs` forward, or a late one would fall behind it and never be seen.
 */
export async function findBlockedBounce(
  auth: OAuthClient,
  sinceMs: number
): Promise<BlockedBounce | null> {
  const gmail = google.gmail({ version: 'v1', auth });
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `from:mailer-daemon after:${Math.floor(sinceMs / 1000)}`,
    includeSpamTrash: true,
    maxResults: 25,
  });

  // Gmail lists newest first, so the first match is the latest block.
  for (const { id } of list.data.messages ?? []) {
    if (!id) continue;
    const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const at = Number(data.internalDate ?? 0);
    if (at <= sinceMs) continue; // `after:` has 1s resolution, so re-filter precisely
    if (isBlockedBounce(`${data.snippet ?? ''}
${messageText(data.payload)}`)) {
      const failed = data.payload?.headers?.find((h) => h.name?.toLowerCase() === 'x-failed-recipients');
      return { at, recipient: failed?.value ?? null };
    }
  }
  return null;
}
