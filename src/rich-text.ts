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
import { htmlToMarkdown, htmlToText, renderMarkdown, safeHref, sanitiseHtml, escapeHtml } from '@chrischall/mcp-utils/rich';
import type { RichElement, RichOutput } from '@chrischall/mcp-utils/rich';

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

/** Top-level `<li>…</li>` items of sanitised list HTML. */
function topLevelItems(html: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = -1;
  for (const m of html.matchAll(/<(\/?)li>/g)) {
    if (m[1] === '') {
      if (depth++ === 0) start = m.index + m[0].length;
    } else if (--depth === 0 && start >= 0) {
      items.push(html.slice(start, m.index));
      start = -1;
    }
  }
  return items;
}

/** How a write renders what Workday's tag set cannot hold. */
function toWorkdayElement(el: RichElement, output: RichOutput, inner: string): string | undefined {
  if (output !== 'html') return undefined;
  switch (el.tag) {
    case 'strong':
      return `<b>${inner}</b>`;
    case 'ol': {
      // Numbers as text, one line per item in one paragraph; a nested list
      // closes the paragraph and follows its item.
      const start = Number(/start\s*=\s*"?(\d+)/i.exec(el.attrs)?.[1] ?? 1);
      let out = '';
      let lines: string[] = [];
      const flush = () => {
        if (lines.length) out += `<p>${lines.join('<br>')}</p>`;
        lines = [];
      };
      topLevelItems(inner).forEach((item, i) => {
        const nested = item.indexOf('<ul>');
        lines.push(`${start + i}. ${nested < 0 ? item : item.slice(0, nested)}`);
        if (nested >= 0) {
          flush();
          out += item.slice(nested);
        }
      });
      flush();
      return out;
    }
    case 'a': {
      const href = safeHref(el.attrs);
      if (href === undefined) return inner;
      const shown = escapeHtml(href);
      return inner === shown || inner === '' ? shown : `${inner} (${shown})`;
    }
    case 'pre':
      return `<p>${inner.replace(/^\n+|\n+$/g, '').replace(/\n/g, '<br>')}</p>`;
    default:
      return undefined;
  }
}

/**
 * Markdown (what an agent writes) as the HTML Workday stores: paragraphs, line
 * breaks, bold, bulleted lists. Raw HTML in the text is escaped; anything
 * Workday has not been seen to keep is written so its meaning survives as
 * text (see the module comment).
 */
export function toWorkdayHtml(markdown: string): string {
  return sanitiseHtml(renderMarkdown(markdown.trim()), { tags: WORKDAY_TAGS, element: toWorkdayElement });
}
