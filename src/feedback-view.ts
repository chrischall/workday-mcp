import type { WorkdayGrid, WorkdayRow } from './parse.js';

export type FeedbackKind = 'received' | 'given' | 'requested';

/** One answer: who wrote it (when Workday says), the question it answers
 *  (when there was one), and the text. Any other column rides along. */
export type FeedbackAnswer = Record<string, string>;

/** A received or given item: the item's own columns (Date, From/About, Type,
 *  visibility) plus every answer it carries. */
export type FeedbackItem = Record<string, string | FeedbackAnswer[]>;

/** One feedback request and where it stands. */
export interface FeedbackRequestStatus {
  request: string;
  about?: string;
  requestedBy?: string;
  /** Everyone the request went to. */
  asked: string[];
  answeredBy: string[];
  waitingOn: string[];
  questions: Array<{ question: string; answers: FeedbackAnswer[]; [column: string]: string | FeedbackAnswer[] }>;
  /** Request Date, Status, visibility — Workday's own column labels. */
  [column: string]: unknown;
}

const ANSWER_KEYS: Record<string, string> = { Question: 'question', Feedback: 'feedback', From: 'from' };
const VISIBILITY = /^(private|confidential):/i;

/** "Feedback Request: Xi Sanderson requested by Chris Hall" → who it is about
 *  and who made it. */
export function parseRequestLabel(label: string): { about?: string; requestedBy?: string } {
  const m = /^Feedback Request:\s*(.+?)\s+requested by\s+(.+)$/i.exec(label.trim());
  return m ? { about: m[1]!, requestedBy: m[2]! } : {};
}

/**
 * Turn the flat feedback grids into the shape a person reads them in.
 *
 * Workday sends each item as a first row plus continuation rows (one per
 * extra answer or responder); `parseGrid` marks those and fills them in. Here
 * the item's own columns go on the entry and its group columns become its
 * `answers`. Feedback Requested is grouped once more — its rows are QUESTIONS
 * — into one entry per request, with who was asked and who has answered.
 */
export function groupFeedback(kind: 'requested', grids: WorkdayGrid[]): FeedbackRequestStatus[];
export function groupFeedback(kind: FeedbackKind, grids: WorkdayGrid[]): FeedbackItem[] | FeedbackRequestStatus[];
export function groupFeedback(kind: FeedbackKind, grids: WorkdayGrid[]): FeedbackItem[] | FeedbackRequestStatus[] {
  const items = grids.flatMap((g) => groupRows(g, kind === 'requested'));
  return kind === 'requested' ? groupRequests(items) : items.map(({ fields, answers }) => ({ ...fields, ...(answers.length ? { answers } : {}) }));
}

interface Grouped {
  fields: Record<string, string>;
  answers: FeedbackAnswer[];
  /** Responders with no text yet (Feedback Requested lists everyone asked). */
  asked: string[];
  first: WorkdayRow;
}

/** On Feedback Requested the response columns are the answer even when
 *  Workday sends them ungrouped — it drops the columnGroup when every request
 *  on the page went to one person. */
const RESPONSE_COLUMNS = ['From', 'Feedback'];

function groupRows(grid: WorkdayGrid, requested: boolean): Grouped[] {
  const group = new Set(grid.groupColumns ?? []);
  if (requested) {
    for (const c of RESPONSE_COLUMNS) if (grid.columns.includes(c)) group.add(c);
    for (const c of grid.columns) if (VISIBILITY.test(c)) group.add(c);
  }
  const out: Grouped[] = [];
  for (const row of grid.rows) {
    const fields: Record<string, string> = {};
    const answer: FeedbackAnswer = {};
    for (const [k, v] of Object.entries(row.cells)) {
      if (group.has(k)) answer[ANSWER_KEYS[k] ?? k] = v;
      else fields[k] = v;
    }
    let item = out[out.length - 1];
    if (!row.continuation || !item) {
      item = { fields, answers: [], asked: [], first: row };
      out.push(item);
    }
    if (answer.from) item.asked.push(answer.from);
    // An asked person who has not answered yet is a "From" with no text.
    const hasText = Object.entries(answer).some(([k, v]) => k !== 'from' && !VISIBILITY.test(k) && v);
    if (hasText) item.answers.push(answer);
  }
  return out;
}

function groupRequests(questions: Grouped[]): FeedbackRequestStatus[] {
  const byRequest = new Map<string, { label: string; rows: Grouped[] }>();
  for (const q of questions) {
    const label = q.fields['Feedback Requested'] ?? '';
    // Two requests on one day share a label ("… requested by …"); the
    // request's instance id is what tells them apart.
    const ref = q.first.references.find((r) => r.instanceId && r.value === label);
    const key = ref?.instanceId ?? `${label}|${q.fields['Request Date'] ?? ''}`;
    const entry = byRequest.get(key) ?? { label, rows: [] };
    entry.rows.push(q);
    byRequest.set(key, entry);
  }
  return [...byRequest.values()].map(({ label, rows }) => {
    const asked = unique(rows.flatMap((r) => r.asked));
    const answeredBy = unique(rows.flatMap((r) => r.answers.map((a) => a.from).filter((f): f is string => !!f)));
    // Visibility is a per-response checkbox; say it once when it agrees.
    const visibility = new Map<string, Set<string>>();
    for (const a of rows.flatMap((r) => r.answers)) {
      for (const [k, v] of Object.entries(a)) if (VISIBILITY.test(k)) (visibility.get(k) ?? visibility.set(k, new Set()).get(k)!).add(v);
    }
    // An open request has no answers to read it from: take the first row's.
    for (const r of rows) {
      for (const [k, v] of Object.entries(r.first.cells)) if (VISIBILITY.test(k) && !visibility.has(k)) visibility.set(k, new Set([v]));
    }
    const hoisted = [...visibility].filter(([, vals]) => vals.size === 1).map(([k, vals]) => [k, [...vals][0]!] as const);
    const hoistedKeys = new Set(hoisted.map(([k]) => k));
    const { 'Feedback Requested': _drop, Question: _q, ...shared } = rows[0]!.fields;
    return {
      request: label,
      ...parseRequestLabel(label),
      ...shared,
      ...Object.fromEntries(hoisted),
      asked,
      answeredBy,
      waitingOn: asked.filter((n) => !answeredBy.includes(n)),
      questions: rows.map((r) => {
        const { 'Feedback Requested': _l, Question, 'Request Date': _d, Status: _s, ...rest } = r.fields;
        return {
          question: Question ?? '',
          ...rest,
          answers: r.answers.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => !hoistedKeys.has(k)))),
        };
      }),
    };
  });
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
