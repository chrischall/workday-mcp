// The Give Feedback and Get Feedback (on self / on an associate) forms.
//
// `parse.ts`' allowlist rule applies: these readers copy named fields off the
// widgets they recognise and never walk the envelope wholesale. Field ids are
// PER PAGE LOAD, so a write must use the ids of the page it just opened.

import { stripHtml } from './parse.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function walk(node: unknown, visit: (o: Obj) => void, depth = 0): void {
  if (depth > 40) return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  visit(node);
  for (const [k, v] of Object.entries(node)) {
    if (/token|secure|flowExecution/i.test(k)) continue;
    walk(v, visit, depth + 1);
  }
}

const hidden = (o: Obj): boolean => o.hideAdvice === 'ALWAYS';

/** A list prompt on the form: searched at `/prompt/<contextId>/<id>`. */
export interface FeedbackPrompt {
  id: string;
  label: string;
  contextId: string;
}

/** Who sees the feedback — Workday's "Feedback Sharing" radio, whose three
 *  choices are separate checkboxes: setting one clears the other two. */
export type FeedbackSharing = 'everyone' | 'private' | 'confidential';

export interface FeedbackSharingOption {
  kind: FeedbackSharing;
  /** The checkbox id: `_eventId_validate=<id>`, `<id>=1` selects it. */
  id: string;
  /** Workday's label, naming the person ("Don't share with Pat Doe"). */
  label: string;
  checked: boolean;
}

const SHARING_KINDS: Array<[RegExp, FeedbackSharing]> = [
  [/Feedback_Confidential$/, 'confidential'],
  [/Feedback_Private$/, 'private'],
  [/Show_Feedback_to_Everyone$/, 'everyone'],
];

export interface FeedbackForm {
  /** The page body's id — `_eventId_submit` on it commits the form. */
  pageId: string;
  /** The business-process bar and its Submit button's value. */
  bar: { id: string; submit: string };
  /** Give Feedback: the rich-text feedback field. */
  feedbackField?: string;
  /** Give Feedback: the badge drop-down. */
  badge?: { id: string; options: Array<{ text: string; instanceId: string }> };
  /** Get Feedback: who to ask. */
  recipients?: FeedbackPrompt;
  /** Get Feedback: the feedback-template prompt. */
  template?: FeedbackPrompt;
  /** Get Feedback: the repeating question list (`editPanelList`). */
  questionList?: string;
  /** The sharing choices, when the form has them. */
  sharing?: FeedbackSharingOption[];
  /** The visibility the form submits with — Workday hides these controls and
   *  sends their defaults, so a preview must say what they are. */
  visibility: string[];
}

/**
 * Read a feedback form. Undefined unless the page carries the Submit bar —
 * i.e. it is the form itself, not its associate prompt.
 */
export function parseFeedbackForm(root: unknown): FeedbackForm | undefined {
  if (!isObj(root) || !isObj(root.body)) return undefined;
  const pageId = str(root.body.id);
  let bar: FeedbackForm['bar'] | undefined;
  let feedbackField: string | undefined;
  let badge: FeedbackForm['badge'];
  let recipients: FeedbackPrompt | undefined;
  let template: FeedbackPrompt | undefined;
  let questionList: string | undefined;
  let showName: boolean | undefined;
  let anonymous: boolean | undefined;
  const sharing: FeedbackSharingOption[] = [];
  walk(root.body, (o) => {
    const widget = str(o.widget);
    const id = str(o.id);
    const label = str(o.label) ?? '';
    if (widget === 'bpfButtonBar' && id && Array.isArray(o.bpfButtons)) {
      const submit = o.bpfButtons.find((b) => isObj(b) && b.label === 'Submit');
      if (isObj(submit) && str(submit.valueIid)) bar = { id, submit: submit.valueIid as string };
    } else if (widget === 'richTextAreaInput' && id && /^feedback$/i.test(label) && !hidden(o)) {
      feedbackField = id;
    } else if (widget === 'dropDownSelectList' && id && /badge/i.test(label)) {
      const options: Array<{ text: string; instanceId: string }> = [];
      walk(o.instances, (opt) => {
        const text = str(opt.text);
        const instanceId = str(opt.instanceId);
        if (opt.widget === 'dropDownSelectOption' && text && instanceId) options.push({ text, instanceId });
      });
      badge = { id, options };
    } else if (widget === 'monikerListInput' && id && str(o.contextId) && !hidden(o)) {
      const prompt = { id, label, contextId: o.contextId as string };
      if (/request feedback from/i.test(label)) recipients = prompt;
      else if (/feedback template/i.test(label)) template = prompt;
    } else if (widget === 'editPanelList' && id && !hidden(o)) {
      questionList ??= id;
    } else if (widget === 'checkBoxInput' && typeof o.value === 'boolean') {
      if (/show my name/i.test(label)) showName = o.value;
      else if (/anonymous/i.test(label)) anonymous = o.value;
    } else if (widget === 'radioGroupInput' && /sharing/i.test(label)) {
      walk(o.children, (c) => {
        const cid = str(c.id);
        const kind = cid ? SHARING_KINDS.find(([re]) => re.test(cid))?.[1] : undefined;
        if (c.widget === 'checkBoxInput' && cid && kind) {
          sharing.push({ kind, id: cid, label: str(c.label) ?? kind, checked: c.value === true });
        }
      });
    }
  });
  if (!pageId || !bar) return undefined;
  const visibility: string[] = [];
  if (showName !== undefined) visibility.push(showName ? 'Your name is shown' : 'Your name is hidden');
  if (anonymous !== undefined) visibility.push(anonymous ? 'Anonymous' : 'Not anonymous');
  const shared = sharing.find((o) => o.checked);
  if (shared) visibility.push(`Shared: ${shared.label}`);
  return {
    pageId,
    bar,
    ...(feedbackField ? { feedbackField } : {}),
    ...(badge ? { badge } : {}),
    ...(recipients ? { recipients } : {}),
    ...(template ? { template } : {}),
    ...(questionList ? { questionList } : {}),
    ...(sharing.length ? { sharing } : {}),
    visibility,
  };
}

/** The question fields a `changeSummary` added (a new row, or a template's). */
function addedQuestionFields(summary: unknown): Obj[] {
  const out: Obj[] = [];
  if (!isObj(summary) || !Array.isArray(summary.changes)) return out;
  for (const change of summary.changes) {
    if (!isObj(change) || change.widget !== 'addChild') continue;
    walk(change.children, (o) => {
      if (o.widget === 'richTextAreaInput' && /Feedback_Question/.test(str(o.id) ?? '')) out.push(o);
    });
  }
  return out;
}

/** A question a change put on the form, with what is needed to rewrite it. */
export interface SummaryQuestionField {
  id: string;
  /** The question as Workday stored it (rich text). */
  html: string;
  text: string;
  /** Its `[BLANK]`s to fill in, e.g. `ENTER BEHAVIOR`. */
  blanks: string[];
}

/** Rich text → plain text, minus the zero-width spaces Workday appends. */
export function questionText(html: string): string {
  return stripHtml(html).replace(/​/g, '').trim();
}

/** The questions a change added (a template's), with their field ids. */
export function summaryQuestionFields(summary: unknown): SummaryQuestionField[] {
  return addedQuestionFields(summary)
    .map((o) => {
      const html = str(o.value) ?? '';
      const text = questionText(html);
      return { id: o.id as string, html, text, blanks: questionBlanks(text) };
    })
    .filter((q) => q.text);
}

/** The `[BLANK]` placeholders in a question — a template's "fill this in"
 *  slots, like `[ENTER BEHAVIOR]` — each once, in order. */
export function questionBlanks(text: string): string[] {
  return [...new Set([...text.matchAll(/\[([^[\]]+)\]/g)].map((m) => m[1]!.trim()))];
}

/** Replace `[BLANK]`s in a question's HTML with the values given by blank
 *  name (case-insensitive), escaped; markup and unknown blanks are kept. */
export function fillBlanks(html: string, fill: Record<string, string>): string {
  const byName = new Map(Object.entries(fill).map(([k, v]) => [k.trim().toLowerCase(), v]));
  return html.replace(/\[([^[\]]+)\]/g, (whole, name: string) => {
    const v = byName.get(name.trim().toLowerCase());
    return v === undefined ? whole : escapeHtml(v);
  });
}

/** Ids of the question fields a row-add created. */
export function questionFieldIds(summary: unknown): string[] {
  return addedQuestionFields(summary).map((o) => o.id as string);
}


const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain text → the rich-text HTML Workday's editor posts: one `<p>` per
 *  paragraph, single line breaks kept as `<br>`, markup escaped. */
export function feedbackHtml(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
