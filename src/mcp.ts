/**
 * Small helpers for shaping tool responses that the MCP SDK expects.
 *
 * `textResult` is the fleet-shared, byte-identical `JSON.stringify(data, null, 2)`
 * text wrapper from `@chrischall/mcp-utils`, re-exported so every `workday_*`
 * tool keeps importing it from `../mcp.js`.
 */
export { textResult } from '@chrischall/mcp-utils';
