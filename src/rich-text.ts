/**
 * Workday rich text, read and written through `@chrischall/mcp-utils/rich`.
 * Only what is Workday's own lives here:
 *
 *  - `&#xa;` is a line break. Workday appends it to business-process comments
 *    and means it as one; in HTML a newline is only whitespace.
 *  - The tags Workday stores. Captured live (91 values across feedback and
 *    review pages, 2026-11-11): `p` (once with `style="text-align:left"`), `br`,
 *    `ul`/`li` (sometimes `li` > `p`), `b`, bare `span`. No `ol`, `a`, `i`/`em`,
 *    `strong`, headings, quotes or code were ever seen, so writes stay inside
 *    that set and say the rest in words: a numbered list keeps its numbers as
 *    text, a link its address.
 *
 * Paragraph breaks — which Workday's editor writes as `<p></p>`,
 * `<br /><br />` or `</p><br /><p>` — semicolon-less `&nbsp`, list items
 * that open with `<p>`, and the zero-width space Workday appends are all
 * handled by the shared module.
 */
import { htmlToMarkdown, htmlToText, renderMarkdown, sanitiseHtml } from '@chrischall/mcp-utils/rich';

/** The tags Workday has been seen to store. A write never emits any other. */
export const WORKDAY_TAGS = ['p', 'br', 'ul', 'li', 'b', 'span'] as const;

const newlines = (html: string): string => html.replace(/&#(?:x0*a|0*10);/gi, '<br>');

/** Prose a person wrote (feedback, comments, answers, instructions), as Markdown. */
export function readRichText(html: string): string {
  return htmlToMarkdown(newlines(html));
}

/** Rich text read as plain text — labels, question prompts, messages. Paragraph
 *  breaks stay as a blank line. */
export function readPlainText(html: string): string {
  return htmlToText(newlines(html), { paragraphs: true });
}

/**
 * Markdown (what an agent writes) as the HTML Workday stores: paragraphs, line
 * breaks, bold, bulleted lists. Raw HTML in the text is escaped; anything
 * Workday has not been seen to keep is written so its meaning survives as
 * text (see the module comment).
 */
export function toWorkdayHtml(markdown: string): string {
  return sanitiseHtml(renderMarkdown(markdown.trim()), { tags: WORKDAY_TAGS });
}
