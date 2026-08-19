// Structural redaction for RAW Workday JSON.
//
// `src/parse.ts` is safe by construction: it reads an explicit allowlist of
// fields, so a secret can never ride out of `parseTask`. The escape-hatch
// tools (`workday_fetch`, `workday_graphql`) have the opposite shape — they
// hand back whatever Workday returned, envelope and all — so they need the
// dual: an explicit DENYlist applied to the whole tree.
//
// Two rules, because Workday leaks along two different axes:
//   1. KEY-based — the envelope's own secrets (`sessionSecureToken`,
//      `flowExecutionKey`, CSRF tokens). Matched on the key name.
//   2. LABEL-based — a `text` widget is `{ label, value }`, so the KEY is
//      always the innocuous `value`; the sensitivity lives in the sibling
//      `label`. A manager reading a direct report's profile can pull an SSN
//      or a bank account this way, so a value whose sibling label names
//      government/financial PII is redacted too.
//   3. COLUMN-based — a `grid` separates the two even further: the label sits
//      in `columns[].label` and the datum in `rows[].cellsMap[columnId]`, so
//      rule 2 cannot see it. PII columns are resolved to their ids and their
//      cells redacted wholesale.

/** Value replacing anything redacted. Deliberately not the empty string, so
 *  a reader can tell "withheld" from "Workday returned nothing". */
export const REDACTED = '[redacted]';

/** Key names whose VALUE is a secret regardless of context. Matched
 *  case-insensitively against the whole key, so `taskIid` / `instanceId` /
 *  `pageContextId` (all benign, all needed for navigation) stay visible. */
export const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /token$/i, // sessionSecureToken, csrfToken, xsrfToken, authToken
  /^secret/i,
  /secret$/i,
  /password/i,
  /passphrase/i,
  /^authorization$/i,
  /^cookie$/i,
  /credential/i,
  /^api[-_]?key$/i,
  /privatekey/i,
  /^flowExecutionKey$/i,
  /^sessionId$/i,
  /^jsessionid$/i,
];

/** Sibling-`label` patterns that make the accompanying `value` sensitive.
 *  Kept narrow — over-redacting a manager's own reports would gut the tool. */
export const SENSITIVE_VALUE_LABELS: readonly RegExp[] = [
  /social security/i,
  /\bssn\b/i,
  /national id/i,
  /passport/i,
  /driver'?s licen[cs]e/i,
  /bank account/i,
  /account number/i,
  /routing number/i,
  /\biban\b/i,
  /tax id/i,
  /\bnin\b/i,
];

export interface RedactOptions {
  /** Recursion cap. Beyond it the subtree is replaced with a marker rather
   *  than walked — Workday envelopes nest deeply and a cyclic or pathological
   *  tree must not blow the stack. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 40;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

function isSensitiveLabel(label: unknown): boolean {
  return typeof label === 'string' && SENSITIVE_VALUE_LABELS.some((re) => re.test(label));
}

/** Column ids of a `grid` whose COLUMN LABEL names PII.
 *
 *  A grid splits the label from the datum: the label lives in
 *  `columns[].label` and the value in `rows[].cellsMap[columnId]`, with no
 *  `label` anywhere near the cell. So the sibling-label rule cannot see it, and
 *  an SSN or bank-account COLUMN would otherwise pass through `workday_fetch`
 *  untouched.
 *
 *  Returns `undefined` when this is not a grid, and a possibly EMPTY set when
 *  it is. That distinction matters: a `columns` array opens a new scope, so a
 *  nested grid with no PII columns must SHADOW an enclosing grid's ids rather
 *  than inherit them — column ids like `1.1` collide freely between grids. */
function sensitiveColumnIds(columns: unknown): Set<string> | undefined {
  if (!Array.isArray(columns)) return undefined;
  const ids = new Set<string>();
  for (const col of columns) {
    if (col === null || typeof col !== 'object' || Array.isArray(col)) continue;
    const c = col as Record<string, unknown>;
    const id = typeof c.columnId === 'string' ? c.columnId : undefined;
    if (id && isSensitiveLabel(c.label)) ids.add(id);
  }
  return ids;
}

/**
 * Deep-copy `node`, replacing every secret-keyed value — every `value` sitting
 * next to a PII `label`, and every grid cell under a PII COLUMN — with
 * {@link REDACTED}. Primitives pass through untouched; cycles and runaway
 * nesting are cut off at `maxDepth`.
 */
export function redactTree(node: unknown, opts: RedactOptions = {}): unknown {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const walk = (
    n: unknown,
    depth: number,
    seen: Set<object>,
    piiColumns?: Set<string>
  ): unknown => {
    if (n === null || typeof n !== 'object') return n;
    if (depth >= maxDepth) return '[truncated: max depth]';
    if (seen.has(n as object)) return '[truncated: cycle]';
    const nextSeen = new Set(seen).add(n as object);
    if (Array.isArray(n)) return n.map((item) => walk(item, depth + 1, nextSeen, piiColumns));
    const src = n as Record<string, unknown>;
    // A sibling `label` naming government/financial PII poisons this object's
    // `value` (and `secondaryValue`) — the widget shape that key-matching alone
    // would sail straight past.
    const piiSiblings = isSensitiveLabel(src.label);
    // Entering a grid: its own `columns` array defines the scope for the rows
    // beneath it — even when it names no PII columns, so an inner grid never
    // inherits an outer grid's colliding ids.
    const columns = sensitiveColumnIds(src.columns) ?? piiColumns;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (isSecretKey(k)) {
        out[k] = REDACTED;
      } else if (piiSiblings && (k === 'value' || k === 'secondaryValue')) {
        out[k] = REDACTED;
      } else if (k === 'cellsMap' && columns && v !== null && typeof v === 'object') {
        const cells = v as Record<string, unknown>;
        const cleaned: Record<string, unknown> = {};
        for (const [colId, cell] of Object.entries(cells)) {
          cleaned[colId] = columns.has(colId)
            ? REDACTED
            : walk(cell, depth + 1, nextSeen, columns);
        }
        out[k] = cleaned;
      } else {
        out[k] = walk(v, depth + 1, nextSeen, columns);
      }
    }
    return out;
  };
  return walk(node, 0, new Set());
}

/**
 * Serialize `data` for a tool result, capping the payload. Raw Workday
 * envelopes routinely exceed 100 KB — far past what is useful in a model's
 * context — so a truncated read plus an explicit marker beats flooding it.
 * Returns the parsed value when it fits, or a `{ truncated }` envelope.
 */
export function capPayload(
  data: unknown,
  maxBytes: number
): { data: unknown; truncated: boolean; bytes: number } {
  const json = JSON.stringify(data) ?? 'null';
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= maxBytes) return { data, truncated: false, bytes };
  return {
    data: {
      truncated: true,
      bytes,
      maxBytes,
      note:
        `Response is ${bytes} bytes, over the ${maxBytes}-byte cap. Showing the first ` +
        `${maxBytes} bytes of its JSON. Narrow the request (a specific card path) or raise ` +
        `maxBytes if you truly need the whole envelope.`,
      preview: json.slice(0, maxBytes),
    },
    truncated: true,
    bytes,
  };
}
