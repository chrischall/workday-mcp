/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, context-groups spec 2026-11-03). Inert data: a host that
 * does not read them sees an extra `_meta` key and nothing else. The shape is
 * fixed by the host's contract, so it is restated here rather than imported —
 * this server takes no dependency on mcp-host.
 *
 * Every tool here is in the `work` group. The one canonical read is the inbox
 * ("what's due at work?"): it has no `subject` (it is one person's own inbox,
 * so there is no listable set of subjects) and no `when` (it takes no range).
 * Nothing here answers "what's new" or "what's on" — there is no calendar or
 * notification feed — so no other tool is canonical.
 *
 * `aliases` are words a person says: lowercase, at most 8, each ≤ 40 chars.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'work';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a Workday tool. */
export function workMeta(intent: MintIntent, extra: Omit<MintHint, 'domain' | 'intent'> = {}): { mint: MintHint } {
  return { mint: { domain: 'work', intent, ...extra } };
}
