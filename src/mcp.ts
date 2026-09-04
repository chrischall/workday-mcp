/**
 * Small helpers for shaping tool responses that the MCP SDK expects.
 *
 * `minifiedResult` is the fleet-shared text wrapper from
 * `@chrischall/mcp-utils`, re-exported so every `workday_*` tool keeps
 * importing it from `../mcp.js`. It emits `JSON.stringify(data)` — no
 * indentation: formatting whitespace is roughly a fifth of a large response
 * and nothing downstream reads it. Whitespace INSIDE a value is content and
 * survives byte-for-byte, which is why this is `JSON.stringify` and not a
 * minifier over the serialised text.
 *
 * (It was `textResult`, which did pretty-print with `null, 2`. The rename is
 * the behaviour change, not just a new name.)
 */
export { minifiedResult } from '@chrischall/mcp-utils';
