// WorkdayClient is the thin, tool-facing API over a WorkdayTransport.
//
// It owns:
//   - deferred config (WORKDAY_TENANT required, WORKDAY_HOST defaulted) so the
//     server still boots for the host's install-time tools/list probe; the
//     config error surfaces on the first tool call.
//   - one fetch primitive, `fetchJson(path)`, that round-trips a Workday
//     `*.htmld` data endpoint through the bridge and parses the JSON body.
//   - error mapping: non-2xx, the SSO/sign-in bounce (expired session), and
//     non-JSON bodies all become typed, actionable errors here so tool authors
//     never handle them.
import {
  detectEdgeBlock,
  EdgeBlockedError,
  formatApiError,
  mapWithConcurrency,
  messageOf,
  readEnvVar,
  requireEnvVar,
  SessionNotAuthenticatedError,
} from '@chrischall/mcp-utils';
import {
  graphqlOperationKinds,
  inspectGraphqlDocument,
  isReadOnlyGraphqlDocument,
  type GraphqlDocumentInfo,
} from '@chrischall/mcp-utils/graphql';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchResult,
  WorkdayTransport,
} from './transport.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  parseTask,
  parseApps,
  parseFormValues,
  parseQuestionnaire,
  parseRequestModel,
  parseWizardSections,
  hasSubmitBar,
  stripHtml,
  type WorkdayTask,
  type WorkdayApp,
  type WorkdayReference,
  type WorkdayOrgChart,
  type WorkdayFormValue,
  type WorkdayGrid,
  type WorkdayQuestionnaire,
  type WorkdayQuestion,
  type WorkdayRequestModel,
  type WorkdayProfileSection,
} from './parse.js';
import { isSecretKey, redactTree } from './redact.js';
import {
  parseDashboardTab,
  parseDashboardTabs,
  parseReportErrors,
  parseReportPrompts,
  type DashboardLink,
  type DashboardWorklet,
  type ReportPrompt,
} from './parse-reports.js';
import {
  feedbackHtml,
  parseFeedbackForm,
  questionFieldIds,
  summaryQuestions,
  type FeedbackForm,
  type FeedbackSharing,
} from './parse-feedback.js';
import {
  changeSummaryXml,
  electionsFromGrid,
  hasWidget,
  isSavedPage,
  isSubmittedPage,
  formatMoney,
  money,
  pageErrors,
  parseContributionForm,
  parseLandingActions,
  parsePlanTypeForm,
  parseSaveModal,
  parseSignForm,
  moneyChange,
  parseEnrollmentEvent,
  parseEnrollmentLanding,
  parsePlanOptions,
  parsePlanRates,
  parseRelatedTaskCatalog,
  type WorkdayBenefitElection,
  type WorkdayCatalogTask,
  type WorkdayPlanOption,
} from './parse-benefits.js';

/** Redaction depth cap for the typed path — generous so it never cuts off a
 *  subtree that `parseTask`'s own depth-40 walks (from nested sub-roots) reach. */
const TYPED_REDACT_MAX_DEPTH = 256;

const DEFAULT_HOST = 'wd5.myworkday.com';

// Re-export the shared "go authenticate" error so tool code (and the
// healthcheck's `instanceof` classifier) keeps importing it from here. The
// Workday-specific SSO re-sign-in copy now lives in the healthcheck's
// `classifyThrown` hint rather than in the error message.
export { SessionNotAuthenticatedError };

export class WorkdayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkdayConfigError';
  }
}

/**
 * Reduce a user-entered `WORKDAY_HOST` to a bare lowercase hostname.
 *
 * The value comes verbatim from env / the `.mcpb` install form, and natural
 * entries — `https://wd5.myworkday.com`, a copied address-bar URL with a path,
 * `WD5.myworkday.com`, a trailing slash — would otherwise break every call:
 * the scheme lands in the bridge subdomain, and the case/slash mismatch makes
 * the off-host check report every good response as an expired SSO session.
 * Blank or unset falls back to the default data-center host.
 */
export function normalizeHost(raw: string | undefined): string {
  let s = (raw ?? '').trim();
  if (!s) return DEFAULT_HOST;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split(/[/?#]/, 1)[0].replace(/\.+$/, '').toLowerCase();
  return s || DEFAULT_HOST;
}

/**
 * Parse `WORKDAY_WS_PORT`. Unset/blank → `undefined` (the bridge default);
 * anything but an integer in 1–65535 throws {@link WorkdayConfigError}, which
 * the entrypoint hands to the client so it surfaces on the deferred-config
 * path instead of reaching the transport as `NaN`.
 */
export function parsePort(raw: string | undefined): number | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new WorkdayConfigError(
      `WORKDAY_WS_PORT is set to "${s}", which is not a valid port. Set it to an integer ` +
        'between 1 and 65535, or unset it to use the default bridge port 37149.'
    );
  }
  return n;
}

export interface WorkdayClientOptions {
  transport: WorkdayTransport;
  /** Overrides for env config — primarily for tests. */
  tenant?: string;
  host?: string;
  /** A config error found by the entrypoint (e.g. an invalid
   *  `WORKDAY_WS_PORT`), surfaced on first use like a missing tenant. */
  configError?: WorkdayConfigError;
}

export interface CrawlOptions {
  /** How many levels of child cards to follow. 0 fetches only the given page. */
  depth?: number;
  /** Hard cap on child fetches, so a hub with 40 cards cannot fan out
   *  unbounded through the user's browser. */
  maxCards?: number;
  /** Child fetches to run at once. */
  concurrency?: number;
}

/** One child card pulled in by a crawl. */
export interface WorkdayCrawledCard {
  uri: string;
  label: string;
  task: WorkdayTask;
}

/** A page plus the child cards it delegates its real content to. */
export interface WorkdayCrawlResult extends WorkdayTask {
  cards: WorkdayCrawledCard[];
  /** Child uris left unfetched because `maxCards` ran out. */
  skipped?: string[];
  /** Child cards that failed, so a partial crawl is still legible. */
  errors?: Array<{ uri: string; error: string }>;
}

/** One person in a team roster. */
export interface WorkdayTeamMember {
  name: string;
  /** Worker instance id, accepted by every worker tool. */
  workerId?: string;
  profileUri?: string;
  /** The roster's other columns (associate id, position, location, …). */
  details: Record<string, string>;
}

/** A supervisory organization you manage, with its members. */
export interface WorkdayTeamOrg {
  name: string;
  id?: string;
  members: WorkdayTeamMember[];
  /** Present when Workday paged the roster: only `shown` of `total` came back. */
  incomplete?: { shown: number; total: number };
}

export interface WorkdayTeam {
  organizations: WorkdayTeamOrg[];
}

/** One performance review in a worker's history. */
export interface WorkdayReviewSummary {
  review: string;
  /** The grid it was listed under ("Completed", "In Progress", …). */
  status: string;
  periodStart?: string;
  periodEnd?: string;
  rating?: string;
  /** GET-able printable view of the review. */
  viewUri?: string;
}

export interface WorkdayReviewSection {
  name: string;
  values: WorkdayFormValue[];
  grids?: WorkdayGrid[];
}

export interface WorkdayReview {
  review: string;
  periodStart?: string;
  periodEnd?: string;
  rating?: string;
  /** The evaluation the printable view is showing, e.g. "Manager Evaluation: …". */
  heading?: string;
  sections: WorkdayReviewSection[];
}

export type FeedbackKind = 'received' | 'given' | 'requested';

/** The profile task each feedback kind lives under. */
const FEEDBACK_TASKS: Record<FeedbackKind, string> = {
  received: 'Feedback Received',
  given: 'Feedback Given',
  requested: 'Feedback Requested',
};

export interface WorkdayRequestForm extends WorkdayQuestionnaire {
  requestType: string;
}

/**
 * Workday's delivered "Create Request" task. Delivered (`2997$`) task ids are
 * Workday's own, not tenant configuration, so this addresses the same task on
 * every tenant — and a GET of it opens the request-type prompt without
 * creating anything.
 */
const CREATE_REQUEST_TASK = '2997$12683';

/** Workday's delivered "My Requests" report — a GET-able grid of the
 *  requests you created, with status. Delivered, like Create Request. */
const MY_REQUESTS_TASK = '3005$4617';
// Workday's delivered feedback tasks (same ids on every tenant, like the two
// above). Give Feedback and Get Feedback on Associate open with an associate
// prompt; Get Feedback on Self opens straight on its form.
const GIVE_FEEDBACK_TASK = '2997$3067';
const GET_FEEDBACK_ON_SELF_TASK = '2997$3241';
const GET_FEEDBACK_ON_ASSOCIATE_TASK = '2997$2976';

export type BenefitsView = 'elections' | 'dependents' | 'beneficiaries' | 'history';

export interface WorkdayBenefits {
  /** The Benefits task that was read ("View My Current Benefit Elections"). */
  matched: string;
  costPeriod?: string;
  elections?: WorkdayBenefitElection[];
  totals?: { youPay?: string; companyPays?: string };
  /** The other views' rows, keyed by column. */
  rows?: Array<Record<string, string>>;
  incomplete?: { shown: number; total: number };
}

export interface BenefitEnrollmentOptions {
  /** Part of the event's inbox title, when several are open. */
  event?: string;
  /** Only this plan type ("medical"), matched case-insensitively. */
  planType?: string;
  /** Add each plan's rate table by coverage level (needs `planType`). */
  rates?: boolean;
}

export type WorkdayEnrollmentPlan = Omit<WorkdayPlanOption, 'detailsUri'> & {
  provider?: string;
  providerUrl?: string;
  rates?: Array<{ coverage: string; youPay: string }>;
};

export interface WorkdayEnrollmentPlanType {
  group?: string;
  planType: string;
  current?: string;
  waived?: true;
  costPeriod?: string;
  plans?: WorkdayEnrollmentPlan[];
  notes?: string[];
  instructions?: string;
}

type MoneyPair = { now?: string; next?: string; change?: string };

export interface WorkdayBenefitEnrollment {
  event?: {
    title: string;
    name?: string;
    opens?: string;
    closes?: string;
    effective?: string;
    instructions?: string;
    status?: string;
  };
  /** What is elected in this event right now — the outcome if you change nothing. */
  elected?: WorkdayBenefitElection[];
  costChanges?: Array<{ plan: string } & MoneyPair>;
  totals?: { period?: string; youPay?: MoneyPair; companyPays?: MoneyPair };
  projectedCost?: string;
  waived?: string[];
  beneficiaries?: Array<Record<string, string>>;
  planTypes?: WorkdayEnrollmentPlanType[];
  toDos?: Array<{ title: string; created?: string }>;
  otherEvents?: string[];
  note?: string;
  errors?: string[];
}

export type BenefitAction = 'save' | 'submit';

/** One requested change to an enrollment: pick `plan`, `waive` the type, or
 *  set an `annualContribution` (HSA/FSA) — alone or with `plan`. */
export interface BenefitChangeInput {
  planType: string;
  plan?: string;
  waive?: boolean;
  annualContribution?: number;
}

export interface BenefitChangePreview {
  planType: string;
  from: string;
  to: string;
}

export interface BenefitUpdatePlan {
  event: string;
  inboxUri: string;
  detailsUri?: string;
  startUri: string;
  action: BenefitAction;
  steps: Array<{ planType: string; uri: string; plan?: string; waive?: boolean; annualContribution?: number }>;
  preview: {
    event: string;
    deadline?: string;
    action: BenefitAction;
    projectedCostNow?: string;
    changes: BenefitChangePreview[];
    unchanged?: string[];
  };
  revision: string;
}

export interface BenefitUpdateResult {
  event: string;
  action: BenefitAction;
  changes: BenefitChangePreview[];
  verified: boolean;
  verification: string;
}

/** One item waiting in your Workday inbox ("My Tasks"). */
export interface WorkdayInboxItem {
  title: string;
  /** The business process it belongs to ("Performance Review", …). */
  type?: string;
  /** What you are asked to do ("Provide Employee Review Comments"). */
  task?: string;
  created?: string;
  effective?: string;
  starred?: boolean;
  /** GET-able page for the task — open it with `workday_get_task`. */
  uri?: string;
  /** GET-able "View Details" page for the business process. */
  detailsUri?: string;
}

export type InboxCategory = 'actions' | 'archive';

/** A request waiting for you to revise (a "Revise Request" inbox task). */
export interface WorkdayOpenRequest {
  /** The request's instance id — what `getRequest` / the write tools take. */
  request: string;
  title: string;
  created?: string;
}

export type RequestAction = 'save' | 'submit';

/** One answer a write will change. `from` is null when unanswered. */
export interface RequestChange {
  number: number;
  question: string;
  from: string | null;
  to: string;
}

/** A write planned against a FRESH read of the request — see `planRequestUpdate`. */
export interface RequestUpdatePlan {
  request: string;
  uri: string;
  model: WorkdayRequestModel;
  /** The flow steps, in order, exactly as they will be posted. */
  steps: Array<Record<string, string>>;
  /** What the user is asked to confirm. */
  preview: { request: string; action: RequestAction; changes: RequestChange[] };
  /** A hash of every saved answer — rotates if the request changes. */
  revision: string;
}

export interface RequestUpdateResult {
  request: string;
  action: RequestAction;
  changes: RequestChange[];
  /** Whether a re-read shows the write took effect. */
  verified: boolean;
  verification: string;
}

const DEFAULT_CRAWL_DEPTH = 1;
const DEFAULT_MAX_CARDS = 12;
const DEFAULT_CRAWL_CONCURRENCY = 4;

/** One table of a report's output. */
export interface WorkdayReportTable {
  label?: string;
  /** Columns that carry data in at least one returned row, in report order. */
  columns: string[];
  /** Rows keyed by column label. */
  rows: Array<Record<string, string>>;
  /** Present when Workday holds more rows than were returned. */
  incomplete?: { shown: number; total: number };
}

export interface WorkdayReportResult {
  report: string;
  reportId?: string;
  /** The prompt values the report ran with (prompt reports only). */
  prompts?: Array<{ label: string; values: string[] }>;
  tables: WorkdayReportTable[];
}

export interface RunReportOptions {
  /** Prompt label (or a distinctive part of it) → the value(s) to set. */
  prompts?: Record<string, string | string[]>;
  /** Most rows to return per table (default 500). */
  limit?: number;
}

export type WorkdayDashboardWorklet = DashboardWorklet & {
  tables?: WorkdayReportTable[];
  error?: string;
};

export interface WorkdayDashboard {
  dashboard: string;
  tabs: Array<{ label: string; worklets: WorkdayDashboardWorklet[]; links: DashboardLink[] }>;
}

export interface GiveFeedbackInput {
  /** The colleague, by name as Workday's people prompt finds them. */
  to: string;
  /** Plain text; paragraphs separated by a blank line. */
  feedback: string;
  /** A badge, by (part of) its name. */
  badge?: string;
  /** Who sees it; omit to keep the form's default. */
  sharing?: FeedbackSharing;
}

export interface GiveFeedbackPreview {
  action: 'give';
  to: string;
  feedback: string;
  badge?: string;
  /** The visibility Workday submits with (its hidden defaults). */
  visibility: string[];
}

export interface RequestFeedbackInput {
  /** Who to ask, by name. */
  from: string[];
  /** One of your reports to ask about; omit to ask about yourself. */
  about?: string;
  /** A feedback template, by (part of) its name. */
  template?: string;
  /** Your own questions, plain text. */
  questions?: string[];
  /** Who sees the answers; omit to keep the form's default. */
  sharing?: FeedbackSharing;
}

export interface RequestFeedbackPreview {
  action: 'request';
  /** `yourself`, or the report the feedback is about. */
  about: string;
  from: string[];
  template?: string;
  /** Every question the request will carry: the template's, then yours. */
  questions: string[];
  visibility: string[];
}

export interface FeedbackPlan<I, P> {
  input: I;
  preview: P;
  /** Hash of the preview and every instance it resolved to. */
  revision: string;
}

export type FeedbackResult<P> = P & { verified: boolean; verification: string };

/** Strip a leading anti-CSRF/guard prefix (anything before the first `{`)
 *  from a Workday JSON body. Live tenants currently emit clean JSON, but
 *  classic Workday endpoints have historically guarded it. */
export function stripJsonGuard(body: string): string {
  const start = body.indexOf('{');
  return start > 0 ? body.slice(start) : body;
}

/** Throw unless `query` declares only read operations. workday-mcp is
 *  read-only, and a GraphQL passthrough is the one place a caller could
 *  otherwise hand Workday a write. */
export function assertReadOnlyGraphql(query: string): void {
  // mcp-utils' inspector (a real tokenizer + cursor parser, fleet-audit#1231)
  // reads the document once; whatever it cannot read is refused below.
  let info: GraphqlDocumentInfo | undefined;
  let unreadable: unknown;
  try {
    info = inspectGraphqlDocument(query);
  } catch (err) {
    unreadable = err;
  }
  const unterminated = unreadable !== undefined && /unterminated/.test(messageOf(unreadable));
  // A document that does not lex cannot be judged. Workday's own parser would
  // reject it as a syntax error, but refusing here keeps the guard fail-closed
  // rather than outsourcing the decision — an unterminated `"""` is exactly the
  // shape that makes a scanner disagree with a real lexer about where a
  // `mutation` lives.
  if (unterminated) {
    throw new Error(
      'workday-mcp could not verify this GraphQL document is read-only: it contains an ' +
        'unterminated string literal. Fix the quoting and retry.'
    );
  }
  // The operation-kind decision is mcp-utils' (a real tokenizer + top-level
  // grammar). Keywords are compared case-insensitively: a capitalised
  // `Mutation` cannot parse anyway, and naming it as a write is the safe
  // reading. A type-system (SDL) word such as `extend` or `scalar` — or any
  // other top-level word — is refused as unverifiable: Workday executes
  // queries, not schema definitions.
  const kinds = graphqlOperationKinds(query).map((k) => k.toLowerCase());
  const write = kinds.find((k) => k === 'mutation' || k === 'subscription');
  if (write) {
    throw new Error(
      `workday-mcp is read-only: the GraphQL document declares a \`${write}\` ` +
        'operation. Only `query` operations are allowed.'
    );
  }
  const other = kinds.find((k) => k !== 'query' && k !== 'fragment');
  if (other) {
    throw new Error(
      `workday-mcp could not verify this GraphQL document is read-only: it contains a ` +
        `top-level \`${other}\` definition (a type-system definition or an unknown keyword), ` +
        'which is neither a query nor a fragment. ' +
        'Send only executable operations (`query` / `fragment`).'
    );
  }
  // Fail closed on anything else the shared check cannot vouch for: unbalanced
  // braces, a malformed definition head, or a document with no query at all.
  if (!isReadOnlyGraphqlDocument(query)) {
    throw new Error(
      'workday-mcp could not verify this GraphQL document is read-only: it does not parse as ' +
        'one or more `query` operations (check the braces and the definition heads).'
    );
  }
  // A document the shared check accepts but the inspector cannot read is
  // refused too: its aliases cannot be listed, so the redaction guard below
  // could not vouch for it.
  if (!info) {
    throw new Error(
      'workday-mcp could not verify this GraphQL document is read-only: it does not parse ' +
        `(${messageOf(unreadable)}).`
    );
  }
  // Find an ALIASED selection of a secret- or PII-named field. The response
  // redactor matches PII by KEY name (`ssn`, `nationalIdentifier`,
  // `bankAccountNumber`), because GraphQL returns plain field-keyed JSON with
  // no sibling label to go on. But the response key is the caller's to choose:
  // an alias renames it, so `{ worker { a: nationalIdentifier } }` comes back
  // as `{ a: "..." }` and no key pattern can fire. One token defeats the
  // redactor, and the threat model is exactly a model (or an instruction
  // injected into fetched content) writing the query.
  const aliased = info.aliases.find((a) => isSecretKey(a.field))?.field;
  if (aliased) {
    throw new Error(
      `workday-mcp refuses to alias the sensitive field \`${aliased}\`: response redaction ` +
        'matches PII and secret fields by their key name, and an alias would rename it out ' +
        'of reach. Select the field under its own name (it will come back redacted).'
    );
  }
}

/** Find a named task in a profile's catalog: an exact label wins, then the
 *  first label containing it (in catalog order). */
function findProfileTask(
  sections: WorkdayProfileSection[],
  label: string
): { section: string; task: WorkdayReference } | null {
  const wanted = label.trim().toLowerCase();
  const all = sections.flatMap((s) =>
    s.tasks.filter((t) => t.uri).map((task) => ({ section: s.label, task }))
  );
  return (
    all.find((e) => e.task.label.toLowerCase() === wanted) ??
    all.find((e) => e.task.label.toLowerCase().includes(wanted)) ??
    null
  );
}

function describeCatalog(sections: WorkdayProfileSection[]): string {
  return (
    sections.map((s) => `${s.label}: ${s.tasks.map((t) => t.label).join(', ')}`).join(' | ') ||
    '(none)'
  );
}

/** The first cell whose column label matches, for grids whose column names
 *  vary slightly between tenants and report versions. */
function cellMatching(cells: Record<string, string>, pattern: RegExp): string | undefined {
  const key = Object.keys(cells).find((k) => pattern.test(k));
  return key ? cells[key] : undefined;
}

/** `MM/DD/YYYY` (Workday's US rendering) or ISO → sortable time; NaN if neither. */
function dateValue(s: string | undefined): number {
  if (!s) return NaN;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  return us ? Date.UTC(+us[3], +us[1] - 1, +us[2]) : Date.parse(s);
}

/** Pick one entry by label: exact (case-insensitive) beats a partial match,
 *  and several partial matches are an error that names them. */
function pickByLabel<T>(items: T[], label: (t: T) => string, wanted: string, what: string): T {
  const w = wanted.trim().toLowerCase();
  const exact = items.filter((i) => label(i).toLowerCase() === w);
  if (exact.length === 1) return exact[0];
  const partial = items.filter((i) => label(i).toLowerCase().includes(w));
  if (partial.length === 1) return partial[0];
  const names = (partial.length ? partial : items).map(label);
  throw new Error(
    partial.length
      ? `"${wanted}" matches more than one ${what}: ${names.join(' | ')}. Use a longer part of the name.`
      : `No ${what} matching "${wanted}". Available: ${names.join(' | ') || '(none)'}.`
  );
}

/** Whitespace-collapsed, for matching text across Workday's renderings. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Whether a Feedback Requested row's question is `asked` — Workday may
 *  show it shortened, so compare the leading text. */
function sameQuestion(shown: string, asked: string): boolean {
  const a = norm(shown).toLowerCase();
  const b = norm(asked).toLowerCase();
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length, 60);
  return n >= Math.min(20, b.length) && a.slice(0, n) === b.slice(0, n);
}

/** `label = a | b` for each prompt, for an error a caller can act on. */
function describePrompts(prompts: ReportPrompt[]): string {
  return prompts.map((p) => `${p.label} = ${p.values.map((v) => v.text).join(' | ') || '(empty)'}`).join('; ');
}

/** The instance id in an inbox task uri (`/{t}/inst/<id>/rel-task/...`). */
function requestIdOf(uri: string): string | undefined {
  return /\/inst\/([^/]+)\/rel-task\//.exec(uri)?.[1];
}

/** The Create Request page's request-type prompt: its id names the field in
 *  the flow POSTs, its contextId addresses the prompt-search endpoint. */
function parseTypeInput(page: Record<string, unknown>): { id: string; contextId: string } | null {
  let hit: { id: string; contextId: string } | null = null;
  const walk = (node: unknown, depth: number): void => {
    if (hit || depth > 40 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    if (
      o.widget === 'monikerListInput' &&
      typeof o.label === 'string' &&
      /request type/i.test(o.label) &&
      typeof o.id === 'string' &&
      typeof o.contextId === 'string'
    ) {
      hit = { id: o.id, contextId: o.contextId };
      return;
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(page.body, 0);
  return hit;
}

/** Match an app by label: case-insensitive substring, or a RegExp. Returns the
 *  first match in menu order — Workday's own relevance ordering. */
function matchApp(apps: WorkdayApp[], match: string | RegExp): WorkdayApp | null {
  const test =
    typeof match === 'string'
      ? (label: string) => label.toLowerCase().includes(match.toLowerCase())
      : (label: string) => match.test(label);
  return apps.find((a) => test(a.label)) ?? null;
}

/** The open benefit event to act on: by part of its title, else the newest. */
function pickBenefitEvent(open: WorkdayInboxItem[], event?: string): WorkdayInboxItem {
  return event
    ? pickByLabel(open, (i) => i.title, event, 'open benefit event')
    : open.reduce((best, i) => ((i.created ?? '') > (best.created ?? '') ? i : best));
}

/** Collapse Workday's doubled spaces ("VSP  Signature") for comparisons. */
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

export class WorkdayClient {
  private readonly transport: WorkdayTransport;
  readonly host: string;
  private readonly tenantValue: string | undefined;
  private readonly configError: WorkdayConfigError | undefined;
  /** Workday's CSRF token for POSTs. Never returned to a caller. */
  private sessionSecureToken: string | undefined;
  /** Learned-once worker-profile uri prefix for this tenant. */
  private profilePrefix: string | undefined;

  constructor(opts: WorkdayClientOptions) {
    this.transport = opts.transport;
    this.host = normalizeHost(opts.host ?? readEnvVar('WORKDAY_HOST'));
    // Required for every data call, so read with requireEnvVar — but caught,
    // not thrown: the server must still boot for the install-time tools/list
    // probe, and the actionable message below surfaces on first use instead.
    let tenant = opts.tenant;
    if (tenant === undefined) {
      try {
        tenant = requireEnvVar('WORKDAY_TENANT');
      } catch {
        tenant = undefined;
      }
    }
    if (opts.configError) {
      this.configError = opts.configError;
    } else if (!tenant) {
      this.configError = new WorkdayConfigError(
        'WORKDAY_TENANT is not set. Set it to your Workday tenant slug — the path segment ' +
          'after the host, e.g. for https://wd5.myworkday.com/acme it is `acme`. ' +
          '(Optionally set WORKDAY_HOST if your data center host is not wd5.myworkday.com.)'
      );
    }
    this.tenantValue = tenant;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Throws the deferred config error if tenant config is missing. */
  get tenant(): string {
    if (this.configError) throw this.configError;
    return this.tenantValue as string;
  }

  /** The deferred config error message, or null when config is present.
   *  Lets the healthcheck report missing config without throwing. */
  get configErrorMessage(): string | null {
    return this.configError ? this.configError.message : null;
  }

  bridgeStatus(): BridgeStatus {
    return this.transport.status();
  }

  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.transport.runProbe(fetchFn, probePath);
  }

  /**
   * Normalize a caller-supplied path to a tenant-scoped Workday data endpoint:
   *   - trim a trailing `#fragment` (browser address-bar URLs carry them)
   *   - prefix `/{tenant}/` when the caller passes a bare suffix
   *   - convert a copied SPA URL (`/{tenant}/d/inst/...`) to its JSON data
   *     endpoint (`/{tenant}/inst/...`) by dropping the `/d/` segment
   */
  resolvePath(path: string): string {
    let p = path.trim();
    const hash = p.indexOf('#');
    if (hash >= 0) p = p.slice(0, hash);
    // A bare Workday task id (e.g. `2998$43525`) resolves to the constructable
    // task data endpoint — lets callers pass an id from workday_get_apps or a
    // prior result's references without knowing the URL shape.
    if (/^\d+\$[A-Za-z0-9_-]+$/.test(p)) return `/${this.tenant}/task/${p}.htmld`;
    if (!p.startsWith('/')) p = `/${this.tenant}/${p}`;
    p = p.replace(`/${this.tenant}/d/`, `/${this.tenant}/`);
    // Workday hands out most drill-in uris WITHOUT the extension, and every
    // one of those 404s until `.htmld` is appended (verified live against a
    // production tenant). Paths that already carry an extension are left be.
    const [pathPart, query] = p.split('?', 2);
    if (!/\.[a-z0-9]+$/i.test(pathPart)) {
      p = query ? `${pathPart}.htmld?${query}` : `${pathPart}.htmld`;
    }
    return p;
  }

  /**
   * GET a Workday `*.htmld` data endpoint and return the parsed JSON object.
   * Throws on non-2xx, an SSO/sign-in bounce, or a non-JSON body.
   */
  async fetchJson(path: string): Promise<unknown> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignedOut(result);
    const stripped = stripJsonGuard(result.body);
    try {
      const json = JSON.parse(stripped);
      this.rememberSessionToken(json);
      return json;
    } catch (e) {
      // Workday answers a task it will not run (a report scoped to an event
      // that is not open, say) with a 200 XML `wml:System_Error`. Its message
      // is the useful part.
      const systemError = /<wml:System_Error[\s\S]*?<wml:Message>([\s\S]*?)<\/wml:Message>/.exec(result.body)?.[1];
      if (systemError) throw new Error(`Workday refused ${path}: ${stripHtml(systemError).trim()}`);
      // A 200 that isn't JSON is almost always the SPA shell HTML or an SSO
      // page — point the user at the data-endpoint vs SPA-route distinction.
      throw new Error(
        `Workday GET ${path} returned a non-JSON body (${(e as Error).message}). ` +
          `This usually means the path is a SPA route (under /d/) or an SSO page rather than a ` +
          `data endpoint. Use the JSON data path (e.g. /${this.tenant}/inst/.../cacheable-task/<id>.htmld).`
      );
    }
  }

  /** GET a path and return the raw body string, applying the non-2xx and
   *  signed-out guards. Used by the healthcheck probe (which wants the body
   *  length, not parsed JSON). */
  async fetchRaw(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignedOut(result);
    return result.body;
  }

  /** Fetch a Workday data endpoint and parse it into a flat, secret-free task.
   *
   *  The parser's allowlist keeps ENVELOPE secrets out, but it copies every
   *  text widget's `{label, value}` and every grid cell verbatim — so the
   *  government/financial PII rules of {@link redactTree} (sibling label, grid
   *  column) run here too, before parsing, exactly as they do for
   *  `fetchRawJson`. Otherwise a manager's `workday_get_worker_task` would
   *  return a report's bank account that `workday_fetch` withholds. The depth
   *  cap is raised well past the parser's own (40, relative to sub-roots) so
   *  redaction never truncates a subtree the parser would still read. */
  async getTask(path: string): Promise<WorkdayTask> {
    const resolved = this.resolvePath(path);
    const json = await this.fetchJson(resolved);
    return parseTask(redactTree(json, { maxDepth: TYPED_REDACT_MAX_DEPTH }));
  }

  /** List the user's Workday apps (label + launchable task id). */
  async getApps(): Promise<WorkdayApp[]> {
    const json = await this.fetchJson(
      `/${this.tenant}/quickaccess/fetch.htmld?shouldFetchUpcApps=true`
    );
    return parseApps(json);
  }

  /**
   * Fetch a page and follow it down to the child cards that carry its real
   * content.
   *
   * This is the single most important read path for anything hub-shaped —
   * which is nearly every Workday app a manager opens. A container task
   * (`My Team`, `Benefits and Pay`) returns a near-empty shell whose child
   * `card/all/<cardId>/<pageCtx>.htmld` endpoints hold the data, and that
   * `pageCtx` token is NOT constructable: it exists only inside the parent's
   * response. So the only way to read a hub is to load it and follow.
   *
   * Bounded on three axes — `depth`, `maxCards`, and a visited set — because
   * every hop is a real fetch through the user's own browser tab. What the
   * budget cut is reported in `skipped`, and a child that fails is recorded in
   * `errors` rather than sinking the whole crawl: a partial read of a hub is
   * far more useful than an exception.
   */
  async crawl(path: string, opts: CrawlOptions = {}): Promise<WorkdayCrawlResult> {
    const depth = opts.depth ?? DEFAULT_CRAWL_DEPTH;
    const maxCards = opts.maxCards ?? DEFAULT_MAX_CARDS;
    const concurrency = opts.concurrency ?? DEFAULT_CRAWL_CONCURRENCY;

    const rootPath = this.resolvePath(path);
    const root = await this.getTask(rootPath);
    const result: WorkdayCrawlResult = { ...root, cards: [] };

    const visited = new Set<string>([rootPath]);
    const skipped: string[] = [];
    const errors: Array<{ uri: string; error: string }> = [];
    let frontier: WorkdayReference[] = root.childCards;

    for (let level = 0; level < depth; level++) {
      const batch: WorkdayReference[] = [];
      for (const ref of frontier) {
        const uri = ref.uri;
        if (!uri || visited.has(uri)) continue;
        visited.add(uri);
        if (result.cards.length + batch.length >= maxCards) {
          skipped.push(uri);
          continue;
        }
        batch.push(ref);
      }
      if (!batch.length) break;

      const fetched = await mapWithConcurrency(batch, concurrency, async (ref) => {
        try {
          return { ref, task: await this.getTask(ref.uri as string) };
        } catch (e) {
          errors.push({ uri: ref.uri as string, error: messageOf(e) });
          return null;
        }
      });

      const next: WorkdayReference[] = [];
      for (const hit of fetched) {
        if (!hit) continue;
        result.cards.push({
          uri: hit.ref.uri as string,
          label: hit.ref.label || hit.task.title || '',
          task: hit.task,
        });
        next.push(...hit.task.childCards);
      }
      frontier = next;
    }

    if (skipped.length) result.skipped = skipped;
    if (errors.length) result.errors = errors;
    return result;
  }

  /**
   * Find one of the user's apps by label. Accepts a substring (matched
   * case-insensitively) or a RegExp, and returns the FIRST app in menu order
   * that matches — menu order being Workday's own relevance ordering.
   *
   * This is what keeps the typed tools (`workday_get_team`, `workday_get_pay`,
   * …) tenant-agnostic: they resolve their entry point from the live app menu
   * at call time rather than carrying a task id captured from one tenant, which
   * would be meaningless on anyone else's.
   */
  async resolveApp(match: string | RegExp): Promise<WorkdayApp | null> {
    return matchApp(await this.getApps(), match);
  }

  /**
   * Resolve an app by label and crawl it in one step — the backbone every
   * typed manager tool is built on. Throws an error naming the apps that DO
   * exist when nothing matches, so a mismatch is self-diagnosing.
   */
  async openApp(match: string | RegExp, opts: CrawlOptions = {}): Promise<WorkdayCrawlResult> {
    // Fetch the menu ONCE and match against it — the error path needs the very
    // same list to name the alternatives.
    const apps = await this.getApps();
    const app = matchApp(apps, match);
    if (!app || !app.taskId) {
      const available = apps.map((a) => a.label);
      throw new Error(
        `No Workday app matching ${match instanceof RegExp ? match.source : `"${match}"`}` +
          `${app && !app.taskId ? ' has a launchable task id' : ' is on your home screen'}. ` +
          `Available apps: ${available.join(', ') || '(none)'}. ` +
          'Use `workday_get_apps` to see them, or open the page in your browser and pass its ' +
          'URL to `workday_get_task`.'
      );
    }
    return this.crawl(app.taskId, opts);
  }

  /**
   * Read the org chart — the reporting chain around the signed-in user.
   *
   * Resolved through the app menu by LABEL rather than a captured task id, so
   * it works on any tenant.
   */
  async getOrgChart(): Promise<WorkdayOrgChart> {
    const page = await this.openApp(/org chart|organization chart/i, { depth: 0 });
    if (!page.org) {
      throw new Error(
        'The Org Chart app did not return a hierarchy. Open it in your browser and pass ' +
          'its URL to `workday_get_task` to see what it returns.'
      );
    }
    return page.org;
  }

  /**
   * The tenant's worker-profile uri prefix (e.g. `/{tenant}/inst/1$715/`).
   *
   * Workday's profile endpoint embeds a task-context id that differs per
   * tenant, so it cannot be hardcoded — but the org chart hands out concrete
   * profile uris for every person it shows, and every one of them shares that
   * prefix. Learning it from live data once keeps `getWorker` tenant-agnostic.
   */
  private async workerProfilePrefix(): Promise<string> {
    if (this.profilePrefix) return this.profilePrefix;
    const org = await this.getOrgChart().catch(() => null);
    const withUri = [...(org?.ancestors ?? []), ...(org?.nodes ?? [])].find(
      (n) => n.profileUri && n.instanceId
    );
    if (!withUri?.profileUri || !withUri.instanceId) {
      throw new Error(
        'Could not learn this tenant\'s worker profile uri from the org chart. ' +
          'Pass a full profile uri instead of a bare worker id — take one from an org chart ' +
          'node\'s `profileUri`, a reference\'s `uri`, or your browser\'s address bar.'
      );
    }
    // Strip the instance id off a known-good profile uri to leave the prefix.
    const idx = withUri.profileUri.lastIndexOf(withUri.instanceId);
    if (idx < 0) {
      throw new Error(
        'The org chart returned a profile uri in an unexpected shape; pass a full profile ' +
          'uri to read a worker.'
      );
    }
    this.profilePrefix = withUri.profileUri.slice(0, idx);
    return this.profilePrefix;
  }

  /**
   * Read a worker's profile — the manager's main entry point into a report's
   * data. Accepts either a full profile uri (from an org chart node or any
   * reference) or a bare worker instance id like `247$42`.
   *
   * The returned page's `profile.sections[].tasks[]` is a catalog of every
   * drill-in Workday offers for that person (Job Details, Compensation,
   * Performance Reviews, Time Off, …), each already fetchable.
   */
  async getWorker(idOrUri: string): Promise<WorkdayTask> {
    const trimmed = idOrUri.trim();
    if (trimmed.startsWith('/') || trimmed.includes('.htmld')) {
      return this.getTask(trimmed);
    }
    const prefix = await this.workerProfilePrefix();
    return this.getTask(`${prefix}${trimmed}.htmld`);
  }

  /**
   * Read the signed-in user's OWN worker profile.
   *
   * Resolved via the org chart's `workerIid` rather than the envelope's
   * `currentUser.iid` — those are different identifiers, and only the worker
   * one addresses a profile.
   */
  async getMyProfile(): Promise<WorkdayTask> {
    const org = await this.getOrgChart();
    if (!org.workerId) {
      throw new Error(
        'The org chart did not identify your worker id. Open your own profile in Workday and ' +
          'pass its URL to `workday_get_worker`.'
      );
    }
    return this.getWorker(org.workerId);
  }

  /**
   * Read ONE named drill-in from a worker's profile, e.g. "Compensation" or
   * "Performance Reviews" — matched case-insensitively against the profile's
   * own task catalog, so the caller never needs the per-worker context id the
   * uri embeds. Lists the real options when nothing matches.
   */
  async getWorkerTask(
    idOrUri: string,
    taskLabel: string
  ): Promise<{ matched: string; section: string; uri: string; task: WorkdayTask }> {
    const profilePage = await this.getWorker(idOrUri);
    return this.openProfileTask(profilePage, taskLabel, "this worker's profile");
  }

  /** Open one named task from an already-fetched profile page (a worker's or
   *  an organization's — both are `compositeView` catalogs). */
  private async openProfileTask(
    profilePage: WorkdayTask,
    taskLabel: string,
    where: string
  ): Promise<{ matched: string; section: string; uri: string; task: WorkdayTask }> {
    const sections = profilePage.profile?.sections ?? [];
    const hit = findProfileTask(sections, taskLabel);
    if (!hit) {
      throw new Error(
        `No task matching "${taskLabel}" on ${where}. Available — ${describeCatalog(sections)}`
      );
    }
    const uri = hit.task.uri as string;
    return { matched: hit.task.label, section: hit.section, uri, task: await this.getTask(uri) };
  }

  /**
   * The teams you manage: every SUPERVISORY organization you lead, with its
   * members.
   *
   * The org chart cannot do this — expanding it downward is a POST-only
   * navigation. Instead this follows plain GETs, each matched by LABEL so no
   * tenant id is assumed: your profile → "Organizations" → the "Manager/Leader
   * of These Organizations" grid → each supervisory org's own profile →
   * "Members".
   */
  async getTeam(): Promise<WorkdayTeam> {
    const me = await this.getMyProfile();
    const orgs = await this.openProfileTask(me, 'Organizations', 'your profile');
    const led = orgs.task.grids.find((g) => /manager|leader/i.test(g.label));
    const supervisory = (led?.rows ?? []).filter((row) => {
      const type = cellMatching(row.cells, /type/i);
      return type === undefined || /supervisory/i.test(type);
    });
    if (!supervisory.length) {
      throw new Error(
        'You do not manage any supervisory organization in Workday (your profile\'s ' +
          '"Organizations" lists no supervisory org under "Manager/Leader of"), so there is no ' +
          'team to list. Use `workday_get_org_chart` to see your reporting chain instead.'
      );
    }
    const organizations: WorkdayTeamOrg[] = [];
    for (const row of supervisory) {
      // Take the reference that IS the "Organization" cell. Matching on the
      // reference's label is not enough: live cells are labelled by column,
      // and "Organization Role" (a link to the role "Manager") matches too.
      const name = cellMatching(row.cells, /^organization$/i);
      const ref = row.references.find((r) => r.uri && name !== undefined && r.value === name);
      if (!name || !ref?.uri) continue;
      const orgPage = await this.getTask(ref.uri);
      const membersPage = await this.openProfileTask(orgPage, 'Members', `the "${name}" organization`);
      const grid = membersPage.task.grids.find((g) => /member/i.test(g.label)) ?? membersPage.task.grids[0];
      const members: WorkdayTeamMember[] = (grid?.rows ?? []).map((r) => {
        const primary =
          Object.keys(r.cells).find((k) => /^(associate|worker|employee|name)$/i.test(k)) ??
          Object.keys(r.cells)[0] ??
          '';
        const person = r.references.find((x) => x.instanceId && x.value === r.cells[primary]);
        const details = Object.fromEntries(Object.entries(r.cells).filter(([k]) => k !== primary));
        return {
          name: r.cells[primary] ?? person?.value ?? '',
          ...(person?.instanceId ? { workerId: person.instanceId } : {}),
          ...(person?.uri ? { profileUri: this.resolvePath(person.uri) } : {}),
          details,
        };
      });
      const shown = grid?.rows.length ?? 0;
      const total = grid?.totalRowCount;
      organizations.push({
        name,
        ...(ref.instanceId ? { id: ref.instanceId } : {}),
        members,
        ...(total !== undefined && total > shown ? { incomplete: { shown, total } } : {}),
      });
    }
    return { organizations };
  }

  /** A worker's performance-review history (newest first, as Workday lists it). */
  async getReviews(worker: string): Promise<{ reviews: WorkdayReviewSummary[] }> {
    const page = await this.getWorkerTask(worker, 'Performance Reviews');
    const reviews: WorkdayReviewSummary[] = [];
    for (const grid of page.task.grids) {
      for (const row of grid.rows) {
        const review = cellMatching(row.cells, /^review$/i);
        if (!review) continue;
        const periodStart = cellMatching(row.cells, /start/i);
        const periodEnd = cellMatching(row.cells, /end date|period end/i);
        const rating = cellMatching(row.cells, /rating/i);
        // The row action column ("View Review"). Anchored: the "Review"
        // column's own link would match a bare /view/.
        const view = row.references.find((r) => /^view\b/i.test(r.label) && r.uri);
        reviews.push({
          review,
          status: grid.label,
          ...(periodStart ? { periodStart } : {}),
          ...(periodEnd ? { periodEnd } : {}),
          ...(rating ? { rating } : {}),
          ...(view?.uri ? { viewUri: view.uri } : {}),
        });
      }
    }
    return { reviews };
  }

  /**
   * Read one review in full: every section's ratings and comments (manager
   * and employee), goals, and development items.
   *
   * `which` is part of the review's name ("2025 year-end") or `latest`. The
   * review's printable view is a task wizard whose sections are each a
   * GET-able page; they are read in turn.
   */
  async getReview(worker: string, which: string): Promise<WorkdayReview> {
    const { reviews } = await this.getReviews(worker);
    const viewable = reviews.filter((r) => r.viewUri);
    let summary: WorkdayReviewSummary;
    if (which.trim().toLowerCase() === 'latest') {
      if (!viewable.length) throw new Error('This worker has no performance review you can view.');
      summary = viewable.reduce((best, r) =>
        dateValue(r.periodEnd) > dateValue(best.periodEnd) ? r : best
      );
    } else {
      summary = pickByLabel(viewable, (r) => r.review, which, 'review');
    }
    const wizard = await this.getRedacted(summary.viewUri as string);
    const sectionRefs = parseWizardSections(wizard);
    const heading = parseTask(wizard)
      .sections.flatMap((s) => s.references)
      .find((r) => r.label === 'Sub-Heading Instance')?.value;
    const pages = sectionRefs.length
      ? await mapWithConcurrency(sectionRefs, 3, async (ref) => ({
          name: ref.label,
          page: await this.getRedacted(ref.uri),
        }))
      : [{ name: summary.review, page: wizard }];
    const sections = pages.map(({ name, page }) => {
      const grids = parseTask(page).grids.filter((g) => g.rows.length);
      return { name, values: parseFormValues(page), ...(grids.length ? { grids } : {}) };
    });
    return {
      review: summary.review,
      ...(summary.periodStart ? { periodStart: summary.periodStart } : {}),
      ...(summary.periodEnd ? { periodEnd: summary.periodEnd } : {}),
      ...(summary.rating ? { rating: summary.rating } : {}),
      ...(heading ? { heading } : {}),
      sections,
    };
  }

  /** Feedback a worker received, gave, or requested, one row per item. */
  async getFeedback(
    worker: string,
    kind: FeedbackKind = 'received'
  ): Promise<{ matched: string; feedback: Array<Record<string, string>>; incomplete?: { shown: number; total: number } }> {
    const page = await this.getWorkerTask(worker, FEEDBACK_TASKS[kind]);
    const rows = page.task.grids.flatMap((g) => g.rows.map((r) => r.cells));
    const shown = page.task.grids.reduce((n, g) => n + g.rows.length, 0);
    const total = page.task.grids.reduce((n, g) => n + (g.totalRowCount ?? g.rows.length), 0);
    return {
      matched: page.matched,
      feedback: rows,
      ...(total > shown ? { incomplete: { shown, total } } : {}),
    };
  }

  /**
   * Load the form of a Workday REQUEST type (e.g. a promotion consideration
   * form) and return its questions — without creating a request.
   *
   * Workday renders a request's form only inside the "Create Request" flow,
   * so this drives that flow the way the UI does and then abandons it:
   *
   *   1. GET the Create Request task — opens the request-type prompt.
   *   2. POST a prompt search for `requestType`.
   *   3. POST the chosen type into the prompt (`_eventId_add`).
   *   4. POST the prompt's OK (`_eventId_submit` on the PROMPT page).
   *   5. ALWAYS POST `_eventId_cancel`, whatever happened above.
   *
   * Nothing is saved until a form's own Submit / Save for Later is pressed,
   * and this never sends either: step 4 is refused if the current page
   * already carries the business-process Submit bar, and no step ever names a
   * button from that bar. Verified live: the abandoned flow leaves nothing
   * under "My Requests" or "Requests In Progress".
   */
  async getRequestForm(requestType: string): Promise<WorkdayRequestForm> {
    const prompt = (await this.fetchJson(`/${this.tenant}/task/${CREATE_REQUEST_TASK}.htmld`)) as Record<
      string,
      unknown
    >;
    const flowKey = typeof prompt.flowExecutionKey === 'string' ? prompt.flowExecutionKey : undefined;
    const body = (prompt.body ?? {}) as Record<string, unknown>;
    const okId = typeof body.id === 'string' ? body.id : undefined;
    const typeInput = parseTypeInput(prompt);
    if (!flowKey || !okId || !typeInput || hasSubmitBar(prompt)) {
      if (flowKey) await this.cancelFlow(flowKey);
      throw new Error(
        'Workday\'s Create Request task did not open its request-type prompt, so the form cannot ' +
          'be loaded safely. Open "Create Request" in your browser to check you can create requests.'
      );
    }
    try {
      const found = (await this.postForm(
        `/${this.tenant}/prompt/${typeInput.contextId}/${typeInput.id}.htmld`,
        { _flowExecutionKey: flowKey, _eventId_prompt: typeInput.id, q: requestType }
      )) as { items?: Array<{ instanceId?: string; text?: string }> };
      const items = (found.items ?? []).filter(
        (i): i is { instanceId: string; text: string } => !!i.instanceId && !!i.text
      );
      if (!items.length) {
        throw new Error(
          `No request type matching "${requestType}" that you can create. Use a distinctive part ` +
            'of the name as it appears under Requests → Create Request.'
        );
      }
      const pick = pickByLabel(items, (i) => i.text, requestType, 'request type');
      const iid = pick.instanceId;
      await this.postForm(`/${this.tenant}/flowController.htmld`, {
        _flowExecutionKey: flowKey,
        _eventId_add: typeInput.id,
        [typeInput.id]: iid,
        [`${iid}_DID`]: pick.text,
        [`${iid}_IID`]: iid,
        [`${iid}_PV`]: '1',
        [`${iid}_V`]: '1',
      });
      // The prompt's OK. Safe ONLY because the page it confirms is the prompt
      // checked above — the same event on a loaded form would submit it.
      const form = await this.postForm(`/${this.tenant}/flowController.htmld`, {
        _flowExecutionKey: flowKey,
        _eventId_submit: okId,
      });
      const questionnaire = parseQuestionnaire(redactTree(form, { maxDepth: TYPED_REDACT_MAX_DEPTH }));
      if (!questionnaire) {
        throw new Error(
          `The "${pick.text}" request opened, but its form is not a questionnaire this server can ` +
            'read. Open it from Requests → Create Request in your browser.'
        );
      }
      return { requestType: pick.text, ...questionnaire };
    } finally {
      await this.cancelFlow(flowKey);
    }
  }

  /**
   * Your Workday inbox ("My Tasks"): review steps, feedback requests,
   * questionnaires and approvals waiting for you.
   *
   * The inbox is a JSON API, not an `.htmld` page, and it wants a DIFFERENT
   * session token from the envelope one: the token inside `boot-config`'s
   * `appRoot` (itself a JSON string). With the envelope token it answers
   * with the HTML app shell. The token is read here, sent as a header, and
   * never returned. Read-only: a plain GET.
   */
  async getInbox(
    category: InboxCategory = 'actions',
    limit = 100
  ): Promise<{ total: number; items: WorkdayInboxItem[] }> {
    const token = await this.inboxToken();
    const cat = category === 'archive' ? 'Archive' : 'Actions';
    const path =
      `/${this.tenant}/internalapi/internalapi/inbox/v2/${this.tenant}/inboxItems` +
      `?category=${cat}&offset=0&limit=${limit}`;
    const result = await this.transport.fetch({
      path,
      method: 'GET',
      headers: { Accept: 'application/json', 'Session-Secure-Token': token },
    });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignedOut(result);
    let json: unknown;
    try {
      json = JSON.parse(result.body);
    } catch {
      throw new Error(
        'Workday answered the inbox request with a web page instead of inbox data, which means ' +
          'it did not accept the inbox session token. Reload your Workday tab and retry.'
      );
    }
    const safe = redactTree(json) as { total?: unknown; data?: unknown };
    const data = Array.isArray(safe.data) ? safe.data : Array.isArray(safe) ? safe : [];
    const items = data.map((raw) => this.inboxItem(raw)).filter((i): i is WorkdayInboxItem => i !== null);
    return { total: typeof safe.total === 'number' ? safe.total : items.length, items };
  }

  private inboxItem(raw: unknown): WorkdayInboxItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, Record<string, unknown> | undefined>;
    const rel = o.relatedItem ?? {};
    const exec = o.taskToExecute ?? {};
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    const title = str(rel.title);
    if (!title) return null;
    const type = str((rel.itemType as Record<string, unknown> | undefined)?.descriptor);
    const uri = str(exec.uri);
    const details = (Array.isArray(o.relatedTasks) ? (o.relatedTasks as Array<Record<string, unknown>>) : []).find(
      (t) => t?.label === 'View Details'
    );
    const detailsUri = str(details?.uri);
    return {
      title,
      ...(type ? { type } : {}),
      ...(str(exec.label) ? { task: str(exec.label) } : {}),
      ...(str(rel.createdDate) ? { created: str(rel.createdDate) } : {}),
      ...(str(rel.effectiveDate) ? { effective: str(rel.effectiveDate) } : {}),
      ...((o.status as Record<string, unknown> | undefined)?.starred === true ? { starred: true } : {}),
      ...(uri ? { uri: this.resolvePath(uri) } : {}),
      ...(detailsUri ? { detailsUri: this.resolvePath(detailsUri) } : {}),
    };
  }

  /** The inbox API's session token, from `boot-config` → `appRoot` (a JSON
   *  string). Held only for the request; never stored or returned. */
  private async inboxToken(): Promise<string> {
    const body = await this.fetchRaw(`/${this.tenant}/boot-config`);
    let token: unknown;
    try {
      const appRoot = (JSON.parse(stripJsonGuard(body)) as { appRoot?: unknown }).appRoot;
      const root = typeof appRoot === 'string' ? JSON.parse(appRoot) : appRoot;
      token = (root as Record<string, unknown> | undefined)?.sessionSecureToken;
    } catch {
      token = undefined;
    }
    if (typeof token !== 'string' || !token) {
      throw new Error(
        'Workday\'s boot-config did not include the inbox session token, so the inbox cannot be ' +
          'read. Reload your Workday tab and retry.'
      );
    }
    return token;
  }

  /**
   * A one-table snapshot of everyone in your organization from the My Team
   * hub's associates report — on a typical tenant: grade, job profile, hire
   * and last-promotion dates, performance rating, pay. The input to a
   * promotion decision in one call.
   *
   * Resolved by LABEL: the My Team hub from your app menu, then the worklet
   * whose name matches `report` (default: the "all associates" report). Only
   * that report is fetched — the hub's other worklets are not crawled.
   */
  async getTeamSnapshot(
    report?: string
  ): Promise<{ report: string; people: Array<Record<string, string>>; incomplete?: { shown: number; total: number } }> {
    // "My Team Management" first: a bare "My Team" app is often the generic
    // launcher, which opens an empty shell.
    const apps = await this.getApps();
    const hubApp = apps.find((a) => /my team management/i.test(a.label)) ?? apps.find((a) => /my team/i.test(a.label));
    const hub = await this.openApp(hubApp ? hubApp.label : /my team/i, { depth: 0 });
    const reports = hub.navigation.filter((n) => n.uri);
    const hit = report
      ? pickByLabel(reports, (n) => n.label, report, 'report on the My Team hub')
      : reports.find((n) => /all associates|associates in my organi[sz]ation/i.test(n.label));
    if (!hit?.uri) {
      throw new Error(
        `No associates report on the My Team hub. Reports there: ${reports.map((n) => n.label).join(' | ') || '(none)'}. ` +
          'Pass one of them as `report`.'
      );
    }
    const page = await this.getTask(hit.uri);
    const people = page.grids.flatMap((g) => g.rows.map((r) => r.cells));
    const total = page.grids.reduce((n, g) => n + (g.totalRowCount ?? g.rows.length), 0);
    return {
      report: hit.label,
      people,
      ...(total > people.length ? { incomplete: { shown: people.length, total } } : {}),
    };
  }

  /**
   * Run a Workday report and return its rows.
   *
   * `report` is a task id (`1422$242`), the report's address-bar URL, or a
   * name found among your dashboards' worklets and report links. A report
   * that answers its GET with a table is returned as is. A report behind a
   * PROMPT form is run the way the web app runs it: on the page's own flow,
   * each requested prompt is cleared, searched and set, then the prompt's OK
   * is pressed — and the flow is always cancelled afterwards.
   *
   * The prompt's OK is safe only on a report: a page carrying a
   * `bpfButtonBar` is a business-process form, where the same event would
   * submit it, so such a page is refused before anything is sent, and a
   * "result" that turns out to be one is cancelled and refused.
   */
  async runReport(report: string, opts: RunReportOptions = {}): Promise<WorkdayReportResult> {
    const limit = opts.limit ?? 500;
    const asked = Object.entries(opts.prompts ?? {});
    const reportId = await this.resolveReport(report);
    const page = (await this.fetchJson(`/${this.tenant}/task/${reportId}.htmld`)) as Record<string, unknown>;
    // Prompt labels and defaults are widget values, so read them from a
    // redacted copy (as `getTask` does); only the flow key comes off the raw
    // page, and it is posted back, never returned.
    const parsed = parseReportPrompts(redactTree(page, { maxDepth: TYPED_REDACT_MAX_DEPTH }));
    const rawFlowKey = typeof page.flowExecutionKey === 'string' ? page.flowExecutionKey : undefined;
    const form = parsed && { okId: parsed.okId, prompts: parsed.prompts, ...(rawFlowKey ? { flowKey: rawFlowKey } : {}) };
    if (!form) {
      if (asked.length) {
        throw new Error(`This report takes no prompts; it ran without them. Drop \`prompts\` and retry.`);
      }
      return { ...this.reportTables(page, limit), reportId };
    }
    if (hasSubmitBar(page) || !form.flowKey) {
      if (form.flowKey) await this.cancelFlow(form.flowKey);
      throw new Error(
        'This task is not a report: it opens a business-process form, which this tool never submits. ' +
          'Open it in Workday instead.'
      );
    }
    const flowKey = form.flowKey;
    try {
      for (const [label, wanted] of asked) {
        const prompt = pickByLabel(form.prompts, (p) => p.label, label, 'prompt on this report');
        await this.setListPrompt(flowKey, prompt, Array.isArray(wanted) ? wanted : [wanted]);
      }
      const result = (await this.postForm(`/${this.tenant}/flowController.htmld`, {
        _flowExecutionKey: flowKey,
        _eventId_submit: form.okId,
      })) as Record<string, unknown>;
      const errors = parseReportErrors(redactTree(result, { maxDepth: TYPED_REDACT_MAX_DEPTH }), form.prompts);
      if (errors.length) {
        throw new Error(
          `Workday did not run the report: ${errors.join(' ')} Prompts were: ${describePrompts(form.prompts)}. ` +
            'Pass `prompts` to change them.'
        );
      }
      if (hasSubmitBar(result)) {
        throw new Error(
          'This task is not a report: its prompt opened a business-process form, which this tool never ' +
            'submits. It was cancelled.'
        );
      }
      const prompts = form.prompts
        .filter((p) => p.values.length)
        .map((p) => ({ label: p.label, values: p.values.map((v) => v.text) }));
      return { ...this.reportTables(result, limit), reportId, prompts };
    } finally {
      await this.cancelFlow(flowKey);
    }
  }

  /** Replace a list prompt's values: remove each current one, then search
   *  for and add each wanted one. Updates `prompt.values` to match. */
  private async setListPrompt(flowKey: string, prompt: ReportPrompt, wanted: string[]): Promise<void> {
    if (prompt.widget !== 'monikerListInput' || !prompt.contextId) {
      throw new Error(
        `The "${prompt.label}" prompt is a ${prompt.widget}; only list prompts can be set here. ` +
          'Run the report without it or set it in Workday.'
      );
    }
    const url = `/${this.tenant}/flowController.htmld`;
    for (const v of prompt.values) {
      if (!v.instanceId) continue;
      await this.postForm(url, { _flowExecutionKey: flowKey, _eventId_remove: prompt.id, [prompt.id]: v.instanceId });
    }
    prompt.values = [];
    for (const value of wanted) {
      const pick = await this.addPromptValue(flowKey, { id: prompt.id, label: prompt.label, contextId: prompt.contextId }, value);
      prompt.values.push({ text: pick.text, instanceId: pick.instanceId });
    }
  }

  /**
   * Search a list prompt on an open flow for `value`, pick the match by label
   * and add it. With `strict`, the add must come back as a change summary
   * (form fields do; a task's opening prompt answers with less), which is
   * returned — a template choice carries the questions it put on the form.
   */
  private async addPromptValue(
    flowKey: string,
    prompt: { id: string; label: string; contextId: string },
    value: string,
    strict = false
  ): Promise<{ text: string; instanceId: string; summary?: Record<string, unknown> }> {
    const found = (await this.postForm(`/${this.tenant}/prompt/${prompt.contextId}/${prompt.id}.htmld`, {
      _flowExecutionKey: flowKey,
      _eventId_prompt: prompt.id,
      q: value,
    })) as { items?: Array<{ instanceId?: string; text?: string }> };
    const items = (found.items ?? []).filter(
      (i): i is { instanceId: string; text: string } => !!i.instanceId && !!i.text
    );
    if (!items.length) {
      throw new Error(
        `No "${prompt.label}" option matching "${value}" that you can pick. Use a distinctive part of ` +
          'the name as Workday shows it in that prompt.'
      );
    }
    const pick = pickByLabel(items, (i) => i.text, value, `"${prompt.label}" option`);
    const iid = pick.instanceId;
    const add = {
      _eventId_add: prompt.id,
      [prompt.id]: iid,
      [`${iid}_DID`]: pick.text,
      [`${iid}_IID`]: iid,
      [`${iid}_PV`]: '1',
      [`${iid}_V`]: '1',
    };
    if (strict) return { text: pick.text, instanceId: iid, summary: await this.flowStep(flowKey, add) };
    await this.postForm(`/${this.tenant}/flowController.htmld`, { _flowExecutionKey: flowKey, ...add });
    return { text: pick.text, instanceId: iid };
  }

  /** One step on an open form that Workday must acknowledge with a change
   *  summary; anything else (a validation error, the page re-rendered) stops
   *  the caller before it can reach Submit. */
  private async flowStep(flowKey: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.postForm(`/${this.tenant}/flowController.htmld`, { _flowExecutionKey: flowKey, ...params });
    if (res && typeof res === 'object' && (res as { widget?: unknown }).widget === 'changeSummary') {
      return res as Record<string, unknown>;
    }
    const errors = parseReportErrors(redactTree(res, { maxDepth: TYPED_REDACT_MAX_DEPTH }), []);
    throw new Error(
      `Workday did not accept a change${errors.length ? `: ${errors.join(' ')}` : ''}. Nothing was sent.`
    );
  }

  /**
   * Open a task that starts with an associate prompt (Give Feedback, Get
   * Feedback on Associate): pick `who`, press the PROMPT's OK, and return the
   * form it opens on the same flow. The prompt's OK is pressed only on a page
   * without a Submit bar; the flow is cancelled on any failure here.
   */
  private async openViaAssociatePrompt(
    taskId: string,
    who: string
  ): Promise<{ flowKey: string; form: Record<string, unknown>; picked: { text: string; instanceId: string } }> {
    const page = (await this.fetchJson(`/${this.tenant}/task/${taskId}.htmld`)) as Record<string, unknown>;
    const flowKey = typeof page.flowExecutionKey === 'string' ? page.flowExecutionKey : undefined;
    const prompts = parseReportPrompts(redactTree(page, { maxDepth: TYPED_REDACT_MAX_DEPTH }));
    const prompt = prompts?.prompts.find((p) => p.widget === 'monikerListInput' && p.contextId);
    if (!flowKey || !prompts || !prompt?.contextId || hasSubmitBar(page)) {
      if (flowKey) await this.cancelFlow(flowKey);
      throw new Error('Workday did not open this task with its associate prompt, so it was left alone.');
    }
    try {
      const picked = await this.addPromptValue(flowKey, { id: prompt.id, label: prompt.label, contextId: prompt.contextId }, who);
      const form = (await this.postForm(`/${this.tenant}/flowController.htmld`, {
        _flowExecutionKey: flowKey,
        _eventId_submit: prompts.okId,
      })) as Record<string, unknown>;
      if (!hasSubmitBar(form)) {
        const errors = parseReportErrors(redactTree(form, { maxDepth: TYPED_REDACT_MAX_DEPTH }), prompts.prompts);
        throw new Error(`Workday did not open the form for ${picked.text}${errors.length ? `: ${errors.join(' ')}` : '.'}`);
      }
      return { flowKey, form, picked };
    } catch (e) {
      await this.cancelFlow(flowKey);
      throw e;
    }
  }

  /**
   * Select a sharing choice (`_eventId_validate=<checkbox>`, value `1` —
   * `true` is refused) and return the visibility lines the form will now
   * submit with. Workday clears the other two choices itself.
   */
  private async setFeedbackSharing(flowKey: string, form: FeedbackForm, sharing?: FeedbackSharing): Promise<string[]> {
    if (!sharing) return form.visibility;
    const opt = form.sharing?.find((o) => o.kind === sharing);
    if (!opt) throw new Error('This feedback form has no sharing choice to set.');
    await this.flowStep(flowKey, { _eventId_validate: opt.id, [opt.id]: '1' });
    return [...form.visibility.filter((v) => !v.startsWith('Shared: ')), `Shared: ${opt.label}`];
  }

  /** Press the form's Submit and commit. A page that comes back still
   *  carrying the Submit bar was sent back, not accepted. */
  private async submitFeedbackForm(flowKey: string, form: FeedbackForm): Promise<void> {
    const { id, submit } = form.bar;
    await this.flowStep(flowKey, { _eventId_add: id, [id]: submit, [`${submit}_DID`]: 'Submit', [`${submit}_IID`]: submit });
    const done = await this.postForm(`/${this.tenant}/flowController.htmld`, {
      _flowExecutionKey: flowKey,
      _eventId_submit: form.pageId,
    });
    if (hasSubmitBar(done)) {
      const errors = parseReportErrors(redactTree(done, { maxDepth: TYPED_REDACT_MAX_DEPTH }), []);
      throw new Error(
        `Workday sent the form back instead of accepting it${errors.length ? `: ${errors.join(' ')}` : ''}. ` +
          'Nothing was submitted.'
      );
    }
  }

  /**
   * Fill the Give Feedback form (recipient, text, badge) and either cancel it
   * (`commitRevision` absent — the plan) or, when the freshly-resolved form
   * still hashes to `commitRevision`, press Submit.
   */
  private async driveGiveFeedback(
    input: GiveFeedbackInput,
    commitRevision?: string
  ): Promise<{ preview: GiveFeedbackPreview; revision: string }> {
    if (!input.feedback.trim()) throw new Error('Feedback text is empty.');
    const { flowKey, form, picked } = await this.openViaAssociatePrompt(GIVE_FEEDBACK_TASK, input.to);
    let committed = false;
    try {
      const f = parseFeedbackForm(redactTree(form, { maxDepth: TYPED_REDACT_MAX_DEPTH }));
      if (!f?.feedbackField) throw new Error('The Give Feedback form has no feedback field this server recognises.');
      const ids = [picked.instanceId];
      const visibility = await this.setFeedbackSharing(flowKey, f, input.sharing);
      await this.flowStep(flowKey, { _eventId_validate: f.feedbackField, [f.feedbackField]: feedbackHtml(input.feedback) });
      let badge: string | undefined;
      if (input.badge) {
        if (!f.badge) throw new Error('This Give Feedback form offers no badge.');
        const opt = pickByLabel(f.badge.options, (o) => o.text, input.badge, 'badge');
        const iid = opt.instanceId;
        await this.flowStep(flowKey, { _eventId_add: f.badge.id, [f.badge.id]: iid, [`${iid}_DID`]: opt.text, [`${iid}_IID`]: iid });
        badge = opt.text;
        ids.push(iid);
      }
      const preview: GiveFeedbackPreview = {
        action: 'give',
        to: picked.text,
        feedback: input.feedback.trim(),
        ...(badge ? { badge } : {}),
        visibility,
      };
      const revision = createHash('sha256').update(JSON.stringify([preview, ids])).digest('hex');
      if (commitRevision !== undefined) {
        if (revision !== commitRevision) {
          throw new Error('The feedback form changed since the preview (recipient or badge resolved differently). Nothing was sent; preview again.');
        }
        await this.submitFeedbackForm(flowKey, f);
        committed = true;
      }
      return { preview, revision };
    } finally {
      if (!committed) await this.cancelFlow(flowKey);
    }
  }

  /** Preview giving feedback: drives the form up to Submit and cancels it,
   *  so the recipient and badge are resolved by Workday itself. Sends nothing. */
  async planGiveFeedback(input: GiveFeedbackInput): Promise<FeedbackPlan<GiveFeedbackInput, GiveFeedbackPreview>> {
    return { input, ...(await this.driveGiveFeedback(input)) };
  }

  /**
   * Give the feedback a plan previewed, on a fresh flow, refusing if anything
   * resolves differently from the preview; then re-read your Feedback Given.
   *
   * Callers MUST gate this behind `confirmWrite` with the plan's preview and
   * revision — see `workday_give_feedback`.
   */
  async applyGiveFeedback(
    plan: FeedbackPlan<GiveFeedbackInput, GiveFeedbackPreview>
  ): Promise<FeedbackResult<GiveFeedbackPreview>> {
    const { preview } = await this.driveGiveFeedback(plan.input, plan.revision);
    const snippet = norm(preview.feedback).slice(0, 40);
    const check = await this.feedbackReread('given', undefined, (row) => row.includes(preview.to) && row.includes(snippet));
    return {
      ...preview,
      verified: check,
      verification: check
        ? `Re-read your Feedback Given: the feedback to ${preview.to} is there.`
        : `Submitted, but could not find it in your Feedback Given yet — check your profile in Workday.`,
    };
  }

  /**
   * Fill a Get Feedback form — on yourself, or `about` one of your reports —
   * with the people to ask, a template and/or your own questions, then cancel
   * it or (revision unchanged) submit it.
   */
  private async driveRequestFeedback(
    input: RequestFeedbackInput,
    commitRevision?: string
  ): Promise<{ preview: RequestFeedbackPreview; revision: string; subjectId?: string }> {
    const from = input.from.map((n) => n.trim()).filter(Boolean);
    const custom = (input.questions ?? []).map((q) => q.trim()).filter(Boolean);
    if (!from.length) throw new Error('Say who to ask: `from` needs at least one name.');
    if (!input.template && !custom.length) throw new Error('Pass at least one question or a template.');
    let flowKey: string;
    let form: Record<string, unknown>;
    let about = 'yourself';
    let subjectId: string | undefined;
    if (input.about) {
      const opened = await this.openViaAssociatePrompt(GET_FEEDBACK_ON_ASSOCIATE_TASK, input.about).catch((e: Error) => {
        throw /^No ".*" option matching/.test(e.message)
          ? new Error(
              `Workday offers no one matching "${input.about}" to request feedback about. Get Feedback on ` +
                'Associate only lists your team or the people under you in your management hierarchy — not ' +
                'peers or managers.'
            )
          : e;
      });
      ({ flowKey, form } = opened);
      about = opened.picked.text;
      subjectId = opened.picked.instanceId;
    } else {
      form = (await this.fetchJson(`/${this.tenant}/task/${GET_FEEDBACK_ON_SELF_TASK}.htmld`)) as Record<string, unknown>;
      if (typeof form.flowExecutionKey !== 'string') throw new Error('Workday did not open Get Feedback on Self.');
      flowKey = form.flowExecutionKey;
    }
    let committed = false;
    try {
      const f = parseFeedbackForm(redactTree(form, { maxDepth: TYPED_REDACT_MAX_DEPTH }));
      if (!f?.recipients || !f.questionList) {
        throw new Error('The Get Feedback form has no recipients or questions this server recognises.');
      }
      const ids: string[] = subjectId ? [subjectId] : [];
      const visibility = await this.setFeedbackSharing(flowKey, f, input.sharing);
      const asked: string[] = [];
      for (const name of from) {
        const v = await this.addPromptValue(flowKey, f.recipients, name, true);
        asked.push(v.text);
        ids.push(v.instanceId);
      }
      const questions: string[] = [];
      let template: string | undefined;
      if (input.template) {
        if (!f.template) throw new Error('This Get Feedback form offers no feedback templates.');
        const v = await this.addPromptValue(flowKey, f.template, input.template, true);
        template = v.text;
        ids.push(v.instanceId);
        questions.push(...summaryQuestions(v.summary));
      }
      for (const q of custom) {
        const row = await this.flowStep(flowKey, { _eventId_add: f.questionList });
        const fieldId = questionFieldIds(row)[0];
        if (!fieldId) throw new Error('Workday added a question row this server cannot read. Nothing was sent.');
        await this.flowStep(flowKey, { _eventId_validate: fieldId, [fieldId]: feedbackHtml(q) });
        questions.push(q);
      }
      const preview: RequestFeedbackPreview = {
        action: 'request',
        about,
        from: asked,
        ...(template ? { template } : {}),
        questions,
        visibility,
      };
      const revision = createHash('sha256').update(JSON.stringify([preview, ids])).digest('hex');
      if (commitRevision !== undefined) {
        if (revision !== commitRevision) {
          throw new Error('The feedback request changed since the preview (people, template or its questions resolved differently). Nothing was sent; preview again.');
        }
        await this.submitFeedbackForm(flowKey, f);
        committed = true;
      }
      return { preview, revision, ...(subjectId ? { subjectId } : {}) };
    } finally {
      if (!committed) await this.cancelFlow(flowKey);
    }
  }

  /** Preview a feedback request: drives the form up to Submit and cancels
   *  it. Sends nothing. */
  async planRequestFeedback(
    input: RequestFeedbackInput
  ): Promise<FeedbackPlan<RequestFeedbackInput, RequestFeedbackPreview>> {
    const { preview, revision } = await this.driveRequestFeedback(input);
    return { input, preview, revision };
  }

  /**
   * Send the feedback request a plan previewed, on a fresh flow, refusing if
   * anything resolves differently; then re-read Feedback Requested.
   *
   * Callers MUST gate this behind `confirmWrite` with the plan's preview and
   * revision — see `workday_request_feedback`.
   */
  async applyRequestFeedback(
    plan: FeedbackPlan<RequestFeedbackInput, RequestFeedbackPreview>
  ): Promise<FeedbackResult<RequestFeedbackPreview>> {
    const { preview, subjectId } = await this.driveRequestFeedback(plan.input, plan.revision);
    // Feedback Requested lists one row PER QUESTION and names no one asked
    // (live columns: Status, Request Date, Question, "Feedback Request: …"),
    // so the request is found by its questions on a row dated today.
    let rows: Array<Record<string, string>> = [];
    try {
      const who = subjectId ?? (await this.getOrgChart()).workerId;
      if (who) rows = (await this.getFeedback(who, 'requested')).feedback;
    } catch {
      // Verification is best effort; the submit itself succeeded.
    }
    const recent = rows.filter((r) => {
      const when = dateValue(r['Request Date']);
      return Number.isNaN(when) || Math.abs(when - Date.now()) < 2 * 86_400_000;
    });
    const missing = preview.questions.filter((q) => !recent.some((r) => sameQuestion(r['Question'] ?? '', q)));
    const verified = recent.length > 0 && missing.length === 0;
    return {
      ...preview,
      verified,
      verification: verified
        ? `Re-read Feedback Requested: all ${preview.questions.length} question(s) are there, requested today.`
        : `Submitted, but could not find ${missing.length ? `"${norm(missing[0]!).slice(0, 60)}"` : 'the request'} ` +
          'in Feedback Requested yet — check it in Workday before sending again.',
    };
  }

  /** One feedback grid (yours, or a report's) as one string per row. */
  private async feedbackRows(kind: FeedbackKind, worker?: string): Promise<string[]> {
    const who = worker ?? (await this.getOrgChart()).workerId;
    if (!who) return [];
    const { feedback } = await this.getFeedback(who, kind);
    return feedback.map((r) => norm(Object.values(r).join(' | ')));
  }

  /** Best-effort re-read: does some row of your `kind` feedback match? */
  private async feedbackReread(kind: FeedbackKind, worker: string | undefined, match: (row: string) => boolean): Promise<boolean> {
    try {
      return (await this.feedbackRows(kind, worker)).some(match);
    } catch {
      return false;
    }
  }

  /** A report page's grids as label-keyed tables, secrets and PII redacted. */
  private reportTables(page: unknown, limit: number): { report: string; tables: WorkdayReportTable[] } {
    const task = parseTask(redactTree(page, { maxDepth: TYPED_REDACT_MAX_DEPTH }));
    const tables = task.grids.map((g): WorkdayReportTable => {
      const all = g.rows.map((r) => r.cells);
      const rows = all.slice(0, Math.max(0, limit));
      const filled = new Set(rows.flatMap((r) => Object.keys(r)));
      const total = Math.max(g.totalRowCount ?? 0, all.length);
      return {
        ...(g.label ? { label: g.label } : {}),
        columns: g.columns.filter((c) => filled.has(c)),
        rows,
        ...(total > rows.length ? { incomplete: { shown: rows.length, total } } : {}),
      };
    });
    return { report: task.title ?? 'Report', tables };
  }

  /** A report reference → its task id: an id, a task url, or a name found on
   *  your dashboards. */
  private async resolveReport(report: string): Promise<string> {
    const r = report.trim();
    if (/^\d+\$[A-Za-z0-9_-]+$/.test(r)) return r;
    const fromPath = /\/task\/(\d+\$[A-Za-z0-9_-]+)/.exec(r)?.[1];
    if (fromPath) return fromPath;
    const known: Array<{ label: string; reportId: string }> = [];
    for (const app of await this.dashboardApps()) {
      try {
        const d = await this.getDashboard(app.taskId as string);
        for (const tab of d.tabs) known.push(...tab.worklets, ...tab.links);
      } catch {
        // A dashboard you cannot open has no reports to offer.
      }
    }
    try {
      return pickByLabel(known, (k) => k.label, r, 'report on your dashboards').reportId;
    } catch (e) {
      throw new Error(
        `${(e as Error).message} Workday's search is not open to this server, so a report that is not on ` +
          'one of your dashboards needs its task id: open it in Workday and pass the address bar URL ' +
          '(…/d/task/1422$242.htmld) or just the id (1422$242).'
      );
    }
  }

  /** Your app-menu entries that are dashboards. */
  private async dashboardApps(): Promise<WorkdayApp[]> {
    return (await this.getApps()).filter((a) => a.taskId && /dashboard/i.test(a.label) && a.label !== 'Dashboards');
  }

  /**
   * A dashboard: each tab's worklets (the report each shows) and its report
   * links. `dashboard` is a dashboard app's name (by label from your app
   * menu), a task id, or its address-bar URL. With `run`, every worklet's
   * report is run as well; one that fails keeps its error instead of failing
   * the whole dashboard.
   */
  async getDashboard(dashboard: string, opts: { run?: boolean; limit?: number } = {}): Promise<WorkdayDashboard> {
    const d = dashboard.trim();
    let taskId = /^\d+\$[A-Za-z0-9_-]+$/.test(d) ? d : /\/task\/(\d+\$[A-Za-z0-9_-]+)/.exec(d)?.[1];
    if (!taskId) {
      const apps = await this.dashboardApps();
      taskId = pickByLabel(apps, (a) => a.label, d, 'dashboard in your app menu').taskId as string;
    }
    const page = await this.getRedacted(`/${this.tenant}/task/${taskId}.htmld`);
    const title = parseTask(page).title ?? d;
    const tabRefs = parseDashboardTabs(page);
    const tabs: WorkdayDashboard['tabs'] = [];
    const pages = tabRefs.length
      ? await Promise.all(
          tabRefs.map(async (t) => ({ label: t.label, page: await this.getRedacted(`/${this.tenant}/task/${t.taskId}.htmld`) }))
        )
      : [{ label: title, page }];
    for (const { label, page: tabPage } of pages) {
      const { worklets, links } = parseDashboardTab(tabPage);
      const out: WorkdayDashboardWorklet[] = [];
      for (const w of worklets) {
        if (!opts.run) {
          out.push(w);
          continue;
        }
        try {
          const r = await this.runReport(w.reportId, { limit: opts.limit ?? 100 });
          out.push({ ...w, tables: r.tables });
        } catch (e) {
          out.push({ ...w, error: (e as Error).message });
        }
      }
      tabs.push({ label, worklets: out, links });
    }
    return { dashboard: title, tabs };
  }

  /**
   * Your own Benefits tasks — the "Benefits" folder of your related-task
   * catalog (`/inst/<you>/rel-tasks`), VIEW tasks only. The catalog's
   * non-view tasks ("Change Benefits") start a business process and are never
   * returned. The catalog uri comes from the envelope's `currentUser` (the
   * signed-in user), read off the org chart page; nothing is hardcoded.
   */
  private async myBenefitTasks(): Promise<WorkdayCatalogTask[]> {
    const page = await this.openApp(/org chart|organization chart/i, { depth: 0 });
    const uri =
      page.user?.relatedTasksUri ??
      (page.org?.workerId ? `/${this.tenant}/inst/${page.org.workerId}/rel-tasks` : undefined);
    if (!uri) {
      throw new Error('Could not find your own task catalog to locate your Benefits tasks.');
    }
    const catalog = parseRelatedTaskCatalog(await this.getRedacted(uri));
    return catalog.filter((t) => t.view && /benefit/i.test(t.folder ?? ''));
  }

  /**
   * Your benefits, read from your own Benefits catalog by label:
   * `elections` (default) — every current election with coverage, covered
   * dependents, beneficiaries and per-pay-period cost to you and the company;
   * `dependents`, `beneficiaries`, `history` — those views' rows. All GETs.
   */
  async getBenefits(show: BenefitsView = 'elections'): Promise<WorkdayBenefits> {
    const tasks = await this.myBenefitTasks();
    const patterns: Record<BenefitsView, RegExp[]> = {
      elections: [/current benefit elections/i, /benefit elections$/i],
      dependents: [/dependents/i],
      beneficiaries: [/beneficiar/i],
      history: [/election history|benefit.*history/i],
    };
    let task: WorkdayCatalogTask | undefined;
    for (const re of patterns[show]) {
      task = tasks.find((t) => re.test(t.label));
      if (task) break;
    }
    if (!task) {
      throw new Error(
        `No Benefits task for ${show} in your Workday task catalog. Benefits tasks you have: ` +
          `${tasks.map((t) => t.label).join(' | ') || '(none)'}.`
      );
    }
    let page = await this.getTask(task.uri);
    if (show !== 'elections') {
      const rows = page.grids.flatMap((g) => g.rows.map((r) => r.cells));
      const total = page.grids.reduce((n, g) => n + (g.totalRowCount ?? g.rows.length), 0);
      return { matched: task.label, rows, ...(total > rows.length ? { incomplete: { shown: rows.length, total } } : {}) };
    }
    // The elections page is a deck of cards; its "View as Grid" (a GET view)
    // is the same data as one table with dates, dependents and both costs.
    if (!page.grids.some((g) => g.rows.length)) {
      const links = [...page.childCards, ...page.navigation, ...page.relatedTasks];
      const asGrid = links.find((l) => /grid/i.test(l.label) && l.uri);
      if (asGrid?.uri) page = await this.getTask(asGrid.uri);
    }
    const grid = page.grids.find((g) => g.rows.length);
    if (!grid) {
      throw new Error(
        `"${task.label}" did not return an elections table. Open it in your browser and pass its ` +
          'URL to `workday_get_task` to see what it returns.'
      );
    }
    return { matched: task.label, ...electionsFromGrid(grid) };
  }

  /**
   * An open benefit event (annual enrollment, a life event) in full, read
   * without changing it:
   *
   * 1. Your inbox's benefit items — the event to open, and any "To Do" steps.
   * 2. The event's inbox page → its enrollment window and the read-only
   *    "Let's Get Started" GET into the elections.
   * 3. The event's "View Details" → what is elected in it right now (a
   *    rollover of last year until you change it), waived types,
   *    beneficiaries, process status — compared against your current
   *    elections, so cost changes are explicit.
   * 4. The elections landing page → one card per plan type → each plan type's
   *    page: every plan on offer with what you and the company would pay.
   *
   * Every step is a GET. The plan-type pages are the ones Workday shows in
   * the enrollment flow; opening one changes no election — only their
   * "Confirm and Continue" and the landing page's "Save for Later" / "Review
   * and Sign" (POSTs) would, and none is ever sent. Verified live: the event
   * stayed "Not Started". It is not invisible, though: Workday badges each
   * opened plan type "Reviewed" in the enrollment page.
   */
  async getBenefitEnrollment(opts: BenefitEnrollmentOptions = {}): Promise<WorkdayBenefitEnrollment> {
    if (opts.rates && !opts.planType) {
      throw new Error(
        'Pass `planType` with `rates` (e.g. "medical"): rates are one extra page per plan, so they ' +
          'are read for one plan type at a time.'
      );
    }
    const { open, toDos } = await this.benefitInbox();
    if (!open.length) {
      return {
        note: 'No open benefit event in your Workday inbox — nothing to enroll in right now.',
        ...(toDos.length ? { toDos } : {}),
      };
    }
    const chosen = pickBenefitEvent(open, opts.event);
    const otherEvents = open.filter((i) => i !== chosen).map((i) => i.title);
    const errors: string[] = [];

    const inboxPage = parseEnrollmentEvent(await this.getRedacted(chosen.uri as string));
    const event: WorkdayBenefitEnrollment['event'] = {
      title: chosen.title,
      ...(inboxPage.event ? { name: inboxPage.event } : {}),
      ...(inboxPage.opens ? { opens: inboxPage.opens } : {}),
      ...(inboxPage.closes ? { closes: inboxPage.closes } : {}),
      ...(chosen.effective ? { effective: chosen.effective } : {}),
      ...(inboxPage.instructions ? { instructions: inboxPage.instructions } : {}),
    };

    const out: WorkdayBenefitEnrollment = { event, elected: [] };
    if (chosen.detailsUri) {
      const details = await this.getTask(chosen.detailsUri);
      const gridNamed = (re: RegExp) => details.grids.find((g) => re.test(g.label));
      const elected = gridNamed(/elected/i);
      const table = elected ? electionsFromGrid(elected) : undefined;
      out.elected = table?.elections ?? [];
      const waived = gridNamed(/waived/i);
      if (waived) out.waived = waived.rows.map((r) => Object.values(r.cells)[0]).filter((v): v is string => !!v);
      const bens = gridNamed(/beneficiar/i);
      if (bens?.rows.length) out.beneficiaries = bens.rows.map((r) => r.cells);
      const history = gridNamed(/process history/i);
      const last = history?.rows[history.rows.length - 1];
      const status = last ? cellMatching(last.cells, /^status$/i) : undefined;
      if (status) event.status = status;

      if (table) {
        try {
          const current = await this.getBenefits('elections');
          const nowBy = new Map(current.elections?.map((e) => [e.plan, e]) ?? []);
          const nextBy = new Map(table.elections.map((e) => [e.plan, e]));
          const plans = [...new Set([...nowBy.keys(), ...nextBy.keys()])];
          const changes = plans.flatMap((plan) => {
            const now = nowBy.get(plan)?.youPay;
            const next = nextBy.get(plan)?.youPay;
            if ((money(now) ?? 0) === (money(next) ?? 0)) return [];
            const change = moneyChange(now, next);
            return [{ plan, ...(now ? { now } : {}), ...(next ? { next } : {}), ...(change ? { change } : {}) }];
          });
          if (changes.length) out.costChanges = changes;
          const pair = (now?: string, next?: string) =>
            now || next
              ? { ...(now ? { now } : {}), ...(next ? { next } : {}), ...(moneyChange(now, next) ? { change: moneyChange(now, next) } : {}) }
              : undefined;
          const youPay = pair(current.totals?.youPay, table.totals?.youPay);
          const companyPays = pair(current.totals?.companyPays, table.totals?.companyPays);
          const period = table.costPeriod ?? current.costPeriod;
          if (youPay || companyPays) {
            out.totals = { ...(period ? { period } : {}), ...(youPay ? { youPay } : {}), ...(companyPays ? { companyPays } : {}) };
          }
        } catch (e) {
          errors.push(`current elections (for the cost comparison): ${messageOf(e)}`);
        }
      }
    }

    if (inboxPage.startUri) {
      const landingPage = parseEnrollmentLanding(await this.getRedacted(inboxPage.startUri));
      let cards = landingPage.planTypes;
      if (opts.planType) {
        const wanted = opts.planType.trim().toLowerCase();
        cards = cards.filter((c) => c.planType.toLowerCase().includes(wanted));
        if (!cards.length) {
          throw new Error(
            `No plan type matching "${opts.planType}" in this event. Plan types: ` +
              `${landingPage.planTypes.map((c) => c.planType).join(' | ') || '(none)'}.`
          );
        }
      }
      if (landingPage.projectedCost) {
        out.projectedCost = landingPage.projectedCost;
      }
      out.planTypes = await mapWithConcurrency(cards, 3, async (card) => {
        const base: WorkdayEnrollmentPlanType = {
          ...(card.group ? { group: card.group } : {}),
          planType: card.planType,
          ...(card.current ? { current: card.current } : {}),
          ...(card.waived ? { waived: true } : {}),
        };
        if (!card.uri) return base;
        try {
          const options = parsePlanOptions(await this.getRedacted(card.uri));
          if (!options) return base;
          const plans: WorkdayEnrollmentPlan[] = await mapWithConcurrency(options.plans, 3, async (p) => {
            const { detailsUri, ...plan } = p;
            if (!opts.rates || !detailsUri) return plan;
            try {
              const r = parsePlanRates(await this.getRedacted(detailsUri));
              return {
                ...plan,
                ...(r.provider ? { provider: r.provider } : {}),
                ...(r.providerUrl ? { providerUrl: r.providerUrl } : {}),
                ...(r.rates.length ? { rates: r.rates } : {}),
              };
            } catch (e) {
              errors.push(`${card.planType} / ${p.plan} rates: ${messageOf(e)}`);
              return plan;
            }
          });
          return {
            ...base,
            ...(options.costPeriod ? { costPeriod: options.costPeriod } : {}),
            plans,
            ...(options.notes ? { notes: options.notes } : {}),
            ...(options.instructions ? { instructions: options.instructions } : {}),
          };
        } catch (e) {
          errors.push(`${card.planType}: ${messageOf(e)}`);
          return base;
        }
      });
    }

    if (toDos.length) out.toDos = toDos;
    if (otherEvents.length) out.otherEvents = otherEvents;
    if (errors.length) out.errors = errors;
    return out;
  }

  /** Your inbox's benefit items: open events, and leftover "To Do" steps. */
  private async benefitInbox(): Promise<{ open: WorkdayInboxItem[]; toDos: Array<{ title: string; created?: string }> }> {
    const { items } = await this.getInbox('actions');
    const benefit = items.filter((i) => /benefit/i.test(i.type ?? '') && i.uri);
    const toDos = benefit
      .filter((i) => /^to ?do$/i.test(i.task ?? ''))
      .map((i) => ({ title: i.title, ...(i.created ? { created: i.created } : {}) }));
    return { open: benefit.filter((i) => !/^to ?do$/i.test(i.task ?? '')), toDos };
  }

  /**
   * Plan changes to an open benefit event from a FRESH read, sending nothing:
   * resolve each plan type and plan by label, validate it, drop changes that
   * are already in place, and preview from → to. `revision` hashes the
   * event's current elections, so a confirmation minted for one state of the
   * enrollment is refused if it changes before the write.
   *
   * Validating a named plan reads that plan type's page, which Workday badges
   * "Reviewed" on the enrollment — no election changes.
   */
  async planBenefitUpdate(opts: {
    event?: string;
    changes: BenefitChangeInput[];
    action: BenefitAction;
  }): Promise<BenefitUpdatePlan> {
    const { open } = await this.benefitInbox();
    if (!open.length) throw new Error('No open benefit event in your Workday inbox — nothing to change.');
    const chosen = pickBenefitEvent(open, opts.event);
    const eventPage = parseEnrollmentEvent(await this.getRedacted(chosen.uri as string));
    if (!eventPage.startUri) {
      throw new Error(`"${chosen.title}" did not open into its elections, so it cannot be changed here.`);
    }
    const landingPage = parseEnrollmentLanding(await this.getRedacted(eventPage.startUri));
    const elected = chosen.detailsUri
      ? electionsFromGrid(
          (await this.getTask(chosen.detailsUri)).grids.find((g) => /elected/i.test(g.label)) ?? {
            label: '',
            columns: [],
            rows: [],
          }
        ).elections
      : [];
    const amountOf = (planType: string): number | undefined => {
      const row = elected.find((e) => squash(e.plan).startsWith(`${squash(planType)} - `));
      return row?.coverage && /annual/i.test(row.coverage) ? money(row.coverage) : undefined;
    };
    const fmtAmount = (n: number) => `${formatMoney(n)} a year`;

    const seen = new Set<string>();
    const steps: BenefitUpdatePlan['steps'] = [];
    const changes: BenefitChangePreview[] = [];
    const unchanged: string[] = [];
    for (const c of opts.changes) {
      const card = pickByLabel(landingPage.planTypes, (t) => t.planType, c.planType, 'plan type in this enrollment');
      if (seen.has(card.planType)) throw new Error(`${card.planType} is changed more than once — give one change per plan type.`);
      seen.add(card.planType);
      if (!card.uri) throw new Error(`${card.planType} has no page to change it on.`);
      const amount = c.annualContribution;
      if (c.waive && (c.plan || amount !== undefined)) {
        throw new Error(`${card.planType}: waive it, or choose a plan / amount — not both.`);
      }
      if (!c.waive && !c.plan && amount === undefined) {
        throw new Error(`${card.planType}: say what to change — a \`plan\`, \`waive: true\`, or an \`annualContribution\`.`);
      }
      if (amount !== undefined && !(Number.isFinite(amount) && amount > 0 && amount < 1_000_000)) {
        throw new Error(`${card.planType}: annualContribution must be a positive amount in dollars.`);
      }
      const current = card.waived ? 'Waived' : card.current ?? '(none)';
      const currentAmount = amountOf(card.planType);
      if (c.waive) {
        if (card.waived) {
          unchanged.push(`${card.planType} (already waived)`);
          continue;
        }
        steps.push({ planType: card.planType, uri: card.uri, waive: true });
        changes.push({ planType: card.planType, from: current, to: 'Waived' });
        continue;
      }
      let plan = c.plan;
      if (plan) {
        const options = parsePlanOptions(await this.getRedacted(card.uri));
        plan = pickByLabel(options?.plans ?? [], (p) => p.plan, plan, `${card.planType} plan`).plan;
      } else {
        if (card.waived || !card.current) {
          throw new Error(`${card.planType} is waived: name the \`plan\` to enroll in along with the amount.`);
        }
        plan = card.current;
      }
      const planSame = !card.waived && squash(plan) === squash(card.current ?? '');
      const amountSame = amount === undefined || currentAmount === amount;
      if (planSame && amountSame) {
        unchanged.push(`${card.planType} (already ${plan}${amount !== undefined ? `, ${fmtAmount(amount)}` : ''})`);
        continue;
      }
      steps.push({
        planType: card.planType,
        uri: card.uri,
        ...(planSame ? {} : { plan }),
        ...(amount !== undefined ? { annualContribution: amount } : {}),
      });
      changes.push({
        planType: card.planType,
        from: amount !== undefined && currentAmount !== undefined ? `${current}, ${fmtAmount(currentAmount)}` : current,
        to: amount !== undefined ? `${plan}, ${fmtAmount(amount)}` : plan,
      });
    }
    if (opts.action === 'save' && !changes.length) {
      throw new Error('Nothing to save: every change given is already in place.');
    }
    const revision = createHash('sha256')
      .update(
        JSON.stringify([
          landingPage.projectedCost ?? null,
          landingPage.planTypes.map((t) => [t.planType, t.current ?? null, t.waived]),
          elected.map((e) => [e.plan, e.coverage ?? null, e.youPay ?? null]),
        ])
      )
      .digest('hex');
    return {
      event: chosen.title,
      inboxUri: chosen.uri as string,
      ...(chosen.detailsUri ? { detailsUri: chosen.detailsUri } : {}),
      startUri: eventPage.startUri,
      action: opts.action,
      steps,
      preview: {
        event: chosen.title,
        ...(eventPage.closes ? { deadline: eventPage.closes } : {}),
        action: opts.action,
        ...(landingPage.projectedCost ? { projectedCostNow: landingPage.projectedCost } : {}),
        changes,
        ...(unchanged.length ? { unchanged } : {}),
      },
      revision,
    };
  }

  /** POST one flow step and require a change summary with no errors. */
  private async flowValidate(params: Record<string, string>): Promise<void> {
    const res = await this.postForm(`/${this.tenant}/flowController.htmld`, params);
    const errors = pageErrors(res);
    if (errors.length) throw new Error(errors.join(' '));
    if (!res || typeof res !== 'object' || (res as { widget?: unknown }).widget !== 'changeSummary') {
      throw new Error('Workday did not accept the change (no change summary came back).');
    }
  }

  /** POST a step that moves to the next page, rejecting Workday errors. */
  private async flowPage(path: string, params: Record<string, string>): Promise<unknown> {
    const res = await this.postForm(this.resolvePath(path), params);
    const errors = pageErrors(res);
    if (errors.length) throw new Error(errors.join(' '));
    return res;
  }

  /** Apply one plan type's change: select / waive, Confirm and Continue, set
   *  an amount when asked, then close the sub-flow. */
  private async applyPlanTypeStep(step: BenefitUpdatePlan['steps'][number]): Promise<void> {
    const form = parsePlanTypeForm(await this.fetchJson(this.resolvePath(step.uri)));
    if (!form) throw new Error('its page did not open as an editable plan choice.');
    const eff: Record<string, string> = form.effective ? { effective: form.effective } : {};
    const base = { _flowExecutionKey: form.flowKey, ...eff };
    const set = async (id: string, paired: string, value: '1') =>
      this.flowValidate({ ...base, _eventId_validate: id, [id]: value, 'change-summary': changeSummaryXml(paired, '0') });
    try {
      if (step.waive) {
        for (const row of form.rows.filter((r) => r.selected)) await set(row.waiveId, row.electId, '1');
      } else if (step.plan) {
        const target = form.rows.find((r) => squash(r.plan) === squash(step.plan as string));
        if (!target) throw new Error(`"${step.plan}" is no longer offered on it.`);
        if (!target.selected) await set(target.electId, target.waiveId, '1');
        for (const row of form.rows.filter((r) => r.selected && r !== target)) await set(row.waiveId, row.electId, '1');
      }
      let res = await this.flowPage(`/${this.tenant}/flowController.htmld`, { ...base, _eventId_submit: form.pageId });
      const contribution = parseContributionForm(res);
      if (step.annualContribution !== undefined && !contribution) {
        throw new Error('Workday showed no contribution page for it, so the annual amount could not be set.');
      }
      if (contribution) {
        const cBase = {
          _flowExecutionKey: contribution.flowKey,
          ...(contribution.effective ? { effective: contribution.effective } : eff),
        };
        if (step.annualContribution !== undefined) {
          await this.flowValidate({
            ...cBase,
            _eventId_validate: contribution.annualId,
            [contribution.annualId]: String(step.annualContribution),
          });
        }
        res = await this.flowPage(`/${this.tenant}/flowController.htmld`, { ...cBase, _eventId_submit: contribution.pageId });
      }
      if (!hasWidget(res, 'slimConclusion')) {
        throw new Error('Workday did not confirm the change (no conclusion page came back).');
      }
    } finally {
      // Close the sub-flow the way the web app does. Best effort.
      if (form.cancelUri) {
        try {
          await this.postForm(this.resolvePath(form.cancelUri), eff);
        } catch {
          // The sub-flow expires with its page context anyway.
        }
      }
    }
  }

  /**
   * Send a planned enrollment change: each plan type in turn, then Save for
   * Later or Review and Sign → I Accept → Submit. Every step must come back
   * as Workday's own acknowledgement; the first that does not stops the
   * write — before any save or submit — and the error says which plan types
   * had already changed in the open enrollment. Then a re-read verifies it.
   *
   * Callers MUST gate this behind `confirmWrite` with the plan's preview and
   * revision — see `workday_update_benefit_enrollment`.
   */
  async applyBenefitUpdate(plan: BenefitUpdatePlan): Promise<BenefitUpdateResult> {
    const done: string[] = [];
    const stop = (where: string, e: unknown): never => {
      throw new Error(
        `Stopped at ${where}: ${messageOf(e)} ` +
          (done.length
            ? `Already changed in the open enrollment (not saved or submitted by this call): ${done.join(', ')}. `
            : 'Nothing was changed. ') +
          'Open the enrollment in Workday to check before retrying.'
      );
    };
    for (const step of plan.steps) {
      try {
        await this.applyPlanTypeStep(step);
      } catch (e) {
        stop(step.planType, e);
      }
      done.push(step.planType);
    }

    const actions = parseLandingActions(await this.fetchJson(this.resolvePath(plan.startUri)));
    if (plan.action === 'save') {
      try {
        if (!actions.save) throw new Error('the enrollment page has no Save for Later button.');
        const modal = parseSaveModal(await this.flowPage(actions.save, {}));
        if (!modal) throw new Error('Workday did not show the "Save Without Submitting?" confirmation.');
        const saved = await this.flowPage(`/${this.tenant}/flowController.htmld`, {
          _flowExecutionKey: modal.flowKey,
          _eventId_submit: modal.pageId,
          'change-summary': changeSummaryXml(modal.confirmId, '1'),
        });
        if (!isSavedPage(saved)) throw new Error('Workday did not confirm the save.');
      } catch (e) {
        stop('Save for Later', e);
      }
    } else {
      try {
        if (!actions.review) throw new Error('the enrollment page has no Review and Sign button.');
        const sign = parseSignForm(await this.flowPage(actions.review, {}));
        if (!sign) throw new Error('the Review and Sign page has no signature and Submit button.');
        const base = { _flowExecutionKey: sign.flowKey };
        await this.flowValidate({ ...base, _eventId_validate: sign.signatureId, [sign.signatureId]: '1' });
        await this.flowValidate({
          ...base,
          _eventId_add: sign.bar.id,
          [sign.bar.id]: sign.bar.submit,
          [`${sign.bar.submit}_DID`]: 'Submit',
          [`${sign.bar.submit}_IID`]: sign.bar.submit,
        });
        const submitted = await this.flowPage(`/${this.tenant}/flowController.htmld`, {
          ...base,
          _eventId_submit: sign.pageId,
        });
        if (!isSubmittedPage(submitted)) throw new Error('Workday did not confirm the submission.');
      } catch (e) {
        stop('Review and Sign', e);
      }
    }

    // Verify by re-reading the event's own record of its elections.
    const notes: string[] = [];
    let verified = true;
    if (plan.detailsUri) {
      const details = await this.getTask(plan.detailsUri);
      const electedGrid = details.grids.find((g) => /elected/i.test(g.label));
      const elected = electedGrid ? electionsFromGrid(electedGrid).elections : [];
      const waived = (details.grids.find((g) => /waived/i.test(g.label))?.rows ?? [])
        .map((r) => squash(Object.values(r.cells)[0] ?? ''));
      const wrong = plan.steps.filter((s) => {
        const type = squash(s.planType);
        if (s.waive) return !waived.includes(type);
        const row = elected.find((e) => squash(e.plan).startsWith(`${type} - `));
        if (!row) return true;
        if (s.plan && squash(row.plan) !== `${type} - ${squash(s.plan)}`) return true;
        if (s.annualContribution !== undefined && money(row.coverage) !== s.annualContribution) return true;
        return false;
      });
      if (wrong.length) verified = false;
      notes.push(
        wrong.length
          ? `Re-read the event: ${wrong.map((s) => s.planType).join(', ')} did not read back as changed.`
          : `Re-read the event: ${plan.steps.length ? plan.steps.map((s) => s.planType).join(', ') + ' read back as changed' : 'elections read back'}.`
      );
    }
    if (plan.action === 'submit') {
      const { open } = await this.benefitInbox();
      const still = open.some((i) => i.uri === plan.inboxUri);
      if (still) verified = false;
      notes.unshift(
        still
          ? 'The enrollment is STILL in your inbox after Submit — check it in Workday.'
          : 'The enrollment is no longer waiting in your inbox: it was submitted.'
      );
    } else {
      notes.unshift('Saved for later: nothing is submitted until Review and Sign.');
    }
    return {
      event: plan.event,
      action: plan.action,
      changes: plan.preview.changes,
      verified,
      verification: notes.join(' '),
    };
  }

  /** The requests waiting for you to revise: your inbox's "Revise Request"
   *  tasks, each named by its instance id. */
  async listOpenRequests(): Promise<WorkdayOpenRequest[]> {
    const { items } = await this.getInbox('actions');
    return items
      .filter((i) => /revise request/i.test(i.task ?? '') && i.uri)
      .map((i) => ({
        request: requestIdOf(i.uri as string) ?? (i.uri as string),
        title: i.title,
        ...(i.created ? { created: i.created } : {}),
      }));
  }

  /**
   * The inbox uri of an open request, by id — or by uri, but only when that
   * uri IS one of your open "Revise Request" tasks. Never a raw path passed
   * through: the write path relies on every request being an open inbox
   * request (its submit verification checks the request left the inbox).
   */
  private async requestUri(request: string): Promise<string> {
    const r = request.trim();
    const wanted = r.startsWith('/') ? requestIdOf(this.resolvePath(r)) : r;
    const { items } = await this.getInbox('actions');
    const open = items.filter((i) => /revise request/i.test(i.task ?? '') && i.uri);
    const hit = wanted
      ? open.find((i) => requestIdOf(i.uri as string) === wanted && (!r.startsWith('/') || i.uri === this.resolvePath(r)))
      : undefined;
    if (!hit?.uri) {
      throw new Error(
        `No open request "${r}" in your inbox. Open requests: ` +
          (open.map((i) => `${requestIdOf(i.uri as string)} (${i.title}, ${i.created ?? 'no date'})`).join(' | ') ||
            '(none)') +
          '.'
      );
    }
    return hit.uri;
  }

  /** Read an open request's questions with their saved answers. A GET. */
  async getRequest(request: string): Promise<{ request: string; title?: string; questions: WorkdayQuestion[] }> {
    const uri = await this.requestUri(request);
    const page = await this.getRedacted(uri);
    const q = parseQuestionnaire(page);
    if (!q) throw new Error(`Request "${request}" did not open as a questionnaire.`);
    return { request: requestIdOf(uri) ?? request, ...(q.title ? { title: q.title } : {}), questions: q.questions };
  }

  /**
   * Plan a change to an open request from a FRESH read: resolve each answer
   * to its question (by number, or a distinctive part of the question text),
   * validate it (a choice must be one of the offered options; a submit needs
   * every required question answered), drop answers equal to what is saved,
   * and lay out the exact flow steps. Sends nothing.
   *
   * The `revision` hashes every saved answer, so a confirmation minted for
   * one state of the request is refused if the request changes before the
   * write.
   */
  async planRequestUpdate(
    request: string,
    answers: Record<string, string>,
    action: RequestAction
  ): Promise<RequestUpdatePlan> {
    const uri = await this.requestUri(request);
    const page = await this.fetchJson(uri);
    const model = parseRequestModel(page);
    if (!model) {
      throw new Error(
        `Request "${request}" did not open as an editable form (no Submit / Save for Later), so it cannot be changed here.`
      );
    }
    const id = requestIdOf(uri) ?? request;
    const byNumber = new Map(model.questions.map((q) => [q.number, q]));
    const changes: RequestChange[] = [];
    const steps: Array<Record<string, string>> = [];
    const final = new Map(model.questions.map((q) => [q.number, q.answer]));
    for (const [key, raw] of Object.entries(answers)) {
      const q = /^\d+$/.test(key.trim())
        ? byNumber.get(Number(key))
        : pickByLabel(model.questions, (x) => x.question, key, 'question');
      if (!q) throw new Error(`No question ${key} on this request (it has ${model.questions.length}).`);
      const field = model.fields.find((f) => f.number === q.number);
      if (!field) throw new Error(`Question ${q.number} ("${q.question}") has no answer field this server can write.`);
      let to = raw;
      if (field.kind === 'choice') {
        const opt = pickByLabel(field.options ?? [], (o) => o.text, raw, `option for "${q.question}"`);
        to = opt.text;
        if (to !== (q.answer ?? '')) {
          steps.push({
            _eventId_add: field.fieldId,
            [field.fieldId]: opt.instanceId,
            [`${opt.instanceId}_DID`]: opt.text,
            [`${opt.instanceId}_IID`]: opt.instanceId,
            [`${opt.instanceId}_PV`]: '1',
            [`${opt.instanceId}_V`]: '1',
          });
        }
      } else if (to !== (q.answer ?? '')) {
        steps.push({ _eventId_validate: field.fieldId, [field.fieldId]: to });
      }
      if (to !== (q.answer ?? '')) {
        changes.push({ number: q.number, question: q.question, from: q.answer ?? null, to });
        final.set(q.number, to);
      }
    }
    changes.sort((a, b) => a.number - b.number);
    if (action === 'save' && !changes.length) {
      throw new Error('Nothing to save: every answer given already matches what the request has.');
    }
    if (action === 'submit') {
      const missing = model.questions.filter((q) => q.required && !(final.get(q.number) ?? '').trim());
      if (missing.length) {
        throw new Error(
          `Cannot submit: required question(s) unanswered — ${missing.map((q) => `${q.number}. ${q.question}`).join('; ')}.`
        );
      }
    }
    const button = action === 'submit' ? model.bar.submit : model.bar.save;
    const label = action === 'submit' ? 'Submit' : 'Save for Later';
    steps.push({
      _eventId_add: model.bar.id,
      [model.bar.id]: button,
      [`${button}_DID`]: label,
      [`${button}_IID`]: button,
    });
    steps.push({ _eventId_submit: model.pageId });
    const revision = createHash('sha256')
      .update(JSON.stringify(model.questions.map((q) => [q.number, q.answer ?? null])))
      .digest('hex');
    return { request: id, uri, model, steps, preview: { request: id, action, changes }, revision };
  }

  /**
   * Send a planned update: each answer change, then the Save for Later or
   * Submit button, then the commit — all on the flow the plan just read.
   * Every step but the commit must come back as a change summary; anything
   * else stops the write before the commit, so nothing is saved. Then a
   * re-read verifies it: a save must show the new answers, a submit must
   * have left your inbox.
   *
   * Callers MUST gate this behind `confirmWrite` with the plan's preview and
   * revision — see `workday_update_request`.
   */
  async applyRequestUpdate(plan: RequestUpdatePlan): Promise<RequestUpdateResult> {
    const flowKey = plan.model.flowKey;
    const commit = plan.steps[plan.steps.length - 1];
    for (const step of plan.steps.slice(0, -1)) {
      let res: unknown;
      try {
        res = await this.postForm(`/${this.tenant}/flowController.htmld`, { _flowExecutionKey: flowKey, ...step });
      } catch (e) {
        throw new Error(`Workday rejected a change before the commit, so nothing was saved: ${messageOf(e)}`);
      }
      if (!res || typeof res !== 'object' || (res as { widget?: unknown }).widget !== 'changeSummary') {
        throw new Error(
          'Workday did not accept a change (no change summary came back), so the request was not committed — nothing was saved.'
        );
      }
    }
    const done = await this.postForm(`/${this.tenant}/flowController.htmld`, { _flowExecutionKey: flowKey, ...commit });
    if (hasSubmitBar(done)) {
      throw new Error(
        'Workday sent the form back instead of accepting it — it likely has a validation error. Open the request in ' +
          'your browser to see it; check whether anything was saved before retrying.'
      );
    }
    const { request, preview } = plan;
    let verified = false;
    let verification: string;
    if (preview.action === 'submit') {
      const open = await this.listOpenRequests();
      verified = !open.some((o) => o.request === request);
      verification = verified
        ? 'The request is no longer waiting in your inbox: it was submitted.'
        : 'The request is STILL in your inbox after Submit — check it in your browser.';
    } else {
      const after = await this.getRequest(request);
      const wrong = preview.changes.filter(
        (c) => (after.questions.find((q) => q.number === c.number)?.answer ?? '') !== c.to
      );
      verified = wrong.length === 0;
      verification = verified
        ? 'Re-read the request: every changed answer is saved.'
        : `Re-read the request: ${wrong.map((c) => `question ${c.number}`).join(', ')} did not read back as saved.`;
    }
    return { request, action: preview.action, changes: preview.changes, verified, verification };
  }

  /** The requests you created (e.g. promotion consideration forms you
   *  submitted) with their status, from Workday's delivered "My Requests". */
  async getMyRequests(): Promise<{ requests: Array<Record<string, string>>; incomplete?: { shown: number; total: number } }> {
    const page = await this.getTask(`/${this.tenant}/task/${MY_REQUESTS_TASK}.htmld`);
    if (!/my requests/i.test(page.title ?? '')) {
      throw new Error(
        `Workday's My Requests report returned "${page.title ?? 'an untitled page'}" instead. Open ` +
          'Requests → My Requests in your browser to check you can see it.'
      );
    }
    const requests = page.grids.flatMap((g) => g.rows.map((r) => r.cells));
    const total = page.grids.reduce((n, g) => n + (g.totalRowCount ?? g.rows.length), 0);
    return { requests, ...(total > requests.length ? { incomplete: { shown: requests.length, total } } : {}) };
  }

  /** Abandon a flow. Best effort: a failure here must not mask the result. */
  private async cancelFlow(flowKey: string): Promise<void> {
    try {
      await this.postForm(`/${this.tenant}/flowController.htmld`, {
        _flowExecutionKey: flowKey,
        _eventId_cancel: 'Cancel',
      });
    } catch {
      // The flow expires with the page context anyway.
    }
  }

  /** GET a page and return it redacted but unparsed, for the readers that
   *  need widgets `parseTask` does not keep (form values, wizard sections). */
  private async getRedacted(path: string): Promise<unknown> {
    const json = await this.fetchJson(this.resolvePath(path));
    return redactTree(json, { maxDepth: TYPED_REDACT_MAX_DEPTH });
  }

  /**
   * GET a path and return the RAW parsed envelope with secrets redacted.
   *
   * The escape hatch for surfaces `parseTask` does not model yet. `parseTask`
   * is safe by construction (allowlist); this is the opposite shape, so it runs
   * the whole tree through {@link redactTree}'s denylist before returning.
   */
  async fetchRawJson(path: string): Promise<unknown> {
    const json = await this.fetchJson(this.resolvePath(path));
    return redactTree(json);
  }

  /**
   * POST a JSON body and return the parsed JSON response.
   *
   * Workday guards state-changing POSTs with the envelope's
   * `sessionSecureToken`. We hold that token privately (captured off any JSON
   * response we have already fetched — see `rememberSessionToken`) and send it
   * as a header; it is NEVER returned to a caller.
   *
   * `opts.retryOnTimeout` re-sends once after a bridge timeout. Leave it unset
   * (the default) for anything that might write; only a provably read-only
   * POST — {@link graphql}, whose document is guarded to `query` — sets it.
   */
  async postJson(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    opts: { retryOnTimeout?: boolean } = {}
  ): Promise<unknown> {
    const result = await this.transport.fetch({
      path,
      method: 'POST',
      ...(opts.retryOnTimeout ? { retryOnTimeout: true } : {}),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(this.sessionSecureToken
          ? { 'X-Workday-Session-Secure-Token': this.sessionSecureToken }
          : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    this.throwIfNotOk(result, 'POST', path);
    this.throwIfSignedOut(result);
    try {
      return JSON.parse(stripJsonGuard(result.body));
    } catch (e) {
      throw new Error(
        `Workday POST ${path} returned a non-JSON body (${(e as Error).message}).`
      );
    }
  }

  /**
   * POST one step of a Workday UI flow (`flowController`, a prompt search):
   * a form-urlencoded body carrying the session token, exactly as the web app
   * sends it. The token rides in the body and the `Session-Secure-Token`
   * header and never leaves this method.
   *
   * Never retried: a flow step moves server-side flow state, so re-sending it
   * after a bridge timeout could apply it twice.
   */
  private async postForm(path: string, params: Record<string, string>): Promise<unknown> {
    await this.primeSessionToken();
    const token = this.sessionSecureToken;
    if (!token) {
      throw new Error(
        'Workday did not hand out a session token, so this step cannot be sent. Reload your ' +
          'Workday tab and retry.'
      );
    }
    const result = await this.transport.fetch({
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'Session-Secure-Token': token,
      },
      body: new URLSearchParams({
        ...params,
        sessionSecureToken: token,
        clientRequestID: randomUUID().replace(/-/g, ''),
      }).toString(),
    });
    this.throwIfNotOk(result, 'POST', path);
    this.throwIfSignedOut(result);
    try {
      const json = JSON.parse(stripJsonGuard(result.body));
      this.rememberSessionToken(json);
      return json;
    } catch (e) {
      throw new Error(`Workday POST ${path} returned a non-JSON body (${(e as Error).message}).`);
    }
  }

  /**
   * Run a GraphQL **query** against Workday's PEX surface.
   *
   * This is the only documented route to the Inbox / "My Tasks" and global
   * search — every guessed `.htmld` path for those 404s (see
   * docs/WORKDAY-API.md). Operations are not published, so the caller supplies
   * the document.
   *
   * The response is passed through {@link redactTree} before it is returned —
   * it is Workday's own payload, so it gets the same denylist as
   * `fetchRawJson`.
   *
   * READ-ONLY GUARD: the document is rejected if it declares a `mutation` or
   * `subscription` operation. The check runs on the document with comments and
   * string literals stripped, so neither a field named `mutationLog` nor the
   * word inside a string can smuggle one past — and, being a keyword check on
   * operation definitions, it fails closed.
   */
  async graphql(
    query: string,
    variables: Record<string, unknown> = {},
    operationName?: string
  ): Promise<unknown> {
    assertReadOnlyGraphql(query);
    const op = operationName ? `?operation=${encodeURIComponent(operationName)}` : '';
    await this.primeSessionToken();
    // Read-only by the guard above (`query` operations only), so a bridge
    // timeout is safe to retry — fetchproxy >= 3.2.0 no longer re-sends POSTs
    // unless asked (chrischall/fleet-audit#312).
    const response = await this.postJson(
      `/wday/pex/graphql/graphql${op}`,
      {
        query,
        variables,
        ...(operationName ? { operationName } : {}),
      },
      {},
      { retryOnTimeout: true }
    );
    // Same contract as `fetchRawJson`: this hands back Workday's own payload,
    // so it gets the denylist. Returning it raw would have contradicted what
    // src/redact.ts, src/tools/raw.ts and CLAUDE.md all promise.
    return redactTree(response);
  }

  /** Ensure a session token has been captured before a POST that needs one.
   *  Cheap: the apps endpoint is small and already used for discovery. */
  private async primeSessionToken(): Promise<void> {
    if (this.sessionSecureToken) return;
    try {
      await this.fetchJson(`/${this.tenant}/quickaccess/fetch.htmld?shouldFetchUpcApps=true`);
    } catch {
      // Best effort — the POST may not need the token; let it speak for itself.
    }
  }

  /** Capture the envelope's session token for use as a POST CSRF header.
   *  Held in a private field and never returned by any method — the parser's
   *  allowlist keeps it out of tool output, and this keeps it out of ours. */
  private rememberSessionToken(json: unknown): void {
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const token = (json as Record<string, unknown>).sessionSecureToken;
      if (typeof token === 'string' && token) this.sessionSecureToken = token;
    }
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    // A CDN/WAF refusal page answers 403 like a dead session, but the request
    // never reached Workday — name it before the 401/403 branch sends the user
    // back through SSO.
    const edge = detectEdgeBlock({ body: result.body, status: result.status });
    if (edge !== null) {
      throw new EdgeBlockedError(result.status, edge.vendor, { service: 'Workday', method, path });
    }
    if (result.status === 401 || result.status === 403) {
      throw new SessionNotAuthenticatedError('Workday', this.host);
    }
    const collapsed = result.body.replace(/\s+/g, ' ').trim();
    throw new Error(
      formatApiError(result.status, method, path, collapsed, { service: 'Workday' })
    );
  }

  private throwIfSignedOut(result: FetchResult): void {
    // Two missing-session signals:
    //   1. The bridge fetch landed off the tenant host — an SSO redirect to
    //      Ping/Okta/Entra (the IdP lives on a different domain).
    //   2. The body is an HTML login/SAML page rather than the JSON widget
    //      tree (SAMLRequest / "Sign On" markers), short enough not to
    //      false-positive on a real data page that merely links to login.
    let offHost = false;
    try {
      offHost = new URL(result.url).host !== this.host;
    } catch {
      offHost = false;
    }
    const looksLikeSso =
      offHost ||
      (!result.body.trimStart().startsWith('{') &&
        /SAMLRequest|loginRedirectUrl|name=["']pingfederate|Sign On to|window\.location\s*=\s*["'][^"']*\/login/i.test(
          result.body
        ) &&
        result.body.length < 200_000);
    if (looksLikeSso) throw new SessionNotAuthenticatedError('Workday', this.host);
  }
}
