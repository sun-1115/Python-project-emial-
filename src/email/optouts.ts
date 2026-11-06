// Honor opt-out replies. Every campaign message invites a reply of "unsubscribe"
// (and its List-Unsubscribe header mails the same request), so the requests land in
// the sending account's inbox. Replies quote the original message, footer included,
// so only the text the person actually wrote may count. Nothing is modified.
const OPT_OUT_RE =
  /\bunsubscribe\b|\bremove me\b|\btake me off\b|\bopt(ing)?[ -]out\b|\bstop (emailing|contacting|sending|messaging)\b|\bdo not (email|contact)\b|\bdon['’]t (email|contact)\b/i;

/** Did the person ask to stop, in the subject or in their own words? */
export function isOptOut(subject: string, ownText: string): boolean {
  return OPT_OUT_RE.test(subject) || OPT_OUT_RE.test(ownText);
}

