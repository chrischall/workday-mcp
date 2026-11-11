/**
 * Benefits pages — the open-enrollment flow and the catalog that leads to it.
 *
 * Like `parse.ts`, every reader here takes an explicit ALLOWLIST of fields
 * (labels, display values, GET uris), so envelope secrets — the
 * `sessionSecureToken`, the enrollment flow's `flowExecutionKey` — cannot ride
 * out. Command buttons are read only when they are GETs: the enrollment pages
 * also carry POST buttons ("Save for Later", "Review and Sign") that would
 * change the user's elections, and those are never surfaced.
 *
 * Shapes captured live in 2026-11 (annual enrollment); see
 * docs/WORKDAY-API.md, "Benefits and open enrollment".
 */
import { stripHtml, type WorkdayGrid } from './parse.js';
import { readRichText } from './rich-text.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Depth-first walk over every object in a widget tree (bounded). */
function eachNode(root: unknown, visit: (node: Obj) => void, maxDepth = 60): void {
  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    visit(node);
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(root, 0);
}

function titleOf(root: Obj): string | undefined {
  return isObj(root.title) ? str(root.title.text) ?? str(root.title.label) : str(root.title);
}

/** Workday currency text → number. Requires a `$` so "2 X Salary" or "13%"
 *  are not misread; `(…)` is negative, trailing words ("Annual") ignored. */
export function money(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /(\()?\$\s*([\d,]+(?:\.\d+)?)/.exec(s);
  if (!m) return undefined;
  const n = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  return m[1] ? -n : n;
}

/** "You Pay (Per Pay Period (Semi-Monthly))" → "Per Pay Period (Semi-Monthly)". */
export function costPeriodOf(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const open = label.indexOf('(');
  if (open < 0 || !label.endsWith(')')) return undefined;
  return label.slice(open + 1, -1).trim() || undefined;
}

// ---------------------------------------------------------------------------
// Related-task catalog (`/inst/<worker>/rel-tasks`)
// ---------------------------------------------------------------------------

export interface WorkdayCatalogTask {
  /** The task's folder ("Benefits"), else its enclosing group's label. */
  folder?: string;
  label: string;
  uri: string;
  /** Workday's own flag: a view task reads; a non-view task starts an action. */
  view: boolean;
}

/** Flatten a `relatedTasks` catalog — the menu of everything you can do on
 *  an instance (your own worker: Benefits, Compensation, Personal Data, …). */
export function parseRelatedTaskCatalog(root: unknown): WorkdayCatalogTask[] {
  if (!isObj(root) || root.widget !== 'relatedTasks') return [];
  const out: WorkdayCatalogTask[] = [];
  const walk = (group: unknown, inherited: string | undefined, depth: number): void => {
    if (depth > 20 || !isObj(group)) return;
    const label = str(group.label) ?? inherited;
    for (const t of Array.isArray(group.tasks) ? group.tasks : []) {
      if (!isObj(t)) continue;
      const taskLabel = str(t.label);
      const uri = str(t.uri);
      if (!taskLabel || !uri) continue;
      const folder = str(t.folder) ?? label;
      out.push({ ...(folder ? { folder } : {}), label: taskLabel, uri, view: t.view === true });
    }
    for (const g of Array.isArray(group.taskGroups) ? group.taskGroups : []) walk(g, label, depth + 1);
  };
  walk(root, undefined, 0);
  return out;
}

// ---------------------------------------------------------------------------
// The enrollment event's inbox page ("Let's Get Started")
// ---------------------------------------------------------------------------

export interface WorkdayEnrollmentEvent {
  event?: string;
  opens?: string;
  closes?: string;
  instructions?: string;
  /** The GET that opens the elections landing page. */
  startUri?: string;
}

const WINDOW_RE = /^(.*?)\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*$/;

/** The page an open-enrollment inbox task opens to: the event name with its
 *  enrollment window ("USA Annual Enrollment 10/26/2026-11/08/2026"), and the
 *  read-only entry into the elections. */
export function parseEnrollmentEvent(root: unknown): WorkdayEnrollmentEvent {
  if (!isObj(root)) return {};
  const out: WorkdayEnrollmentEvent = {};
  eachNode(root.body, (n) => {
    const prop = str(n.propertyName) ?? '';
    if (n.widget === 'richTextArea' && /EventType/i.test(prop) && !out.event) {
      const text = stripHtml(str(n.value) ?? '').trim();
      const m = WINDOW_RE.exec(text);
      if (m) {
        if (m[1]) out.event = m[1];
        out.opens = m[2];
        out.closes = m[3];
      } else if (text) {
        out.event = text;
      }
    } else if (n.widget === 'text' && /Instruction/i.test(prop) && !out.instructions) {
      const v = str(n.value);
      if (v) out.instructions = v;
    } else if (n.widget === 'commandButton' && !out.startUri) {
      if (str(n.httpMethod)?.toUpperCase() === 'GET' && str(n.uri)) out.startUri = str(n.uri);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The elections landing page: one card per plan type
// ---------------------------------------------------------------------------

export interface WorkdayPlanTypeCard {
  group?: string;
  planType: string;
  /** The plan currently chosen in this event, or "Waived". */
  current?: string;
  waived: boolean;
  /** The plan-type page (a GET) listing the plans on offer. */
  uri?: string;
}

export interface WorkdayEnrollmentLanding {
  projectedCost?: string;
  costPeriod?: string;
  planTypes: WorkdayPlanTypeCard[];
}

export function parseEnrollmentLanding(root: unknown): WorkdayEnrollmentLanding {
  const out: WorkdayEnrollmentLanding = { planTypes: [] };
  if (!isObj(root)) return out;
  const walk = (node: unknown, group: string | undefined, depth: number): void => {
    if (depth > 60) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, group, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    if (node.widget === 'stylizedHeaderRightJustifiedField' && !out.projectedCost) {
      const heading = (Array.isArray(node.headings) ? node.headings : []).find(isObj);
      const value = heading ? str(heading.value) : undefined;
      if (value) out.projectedCost = value;
      const period = costPeriodOf(str(node.label));
      if (period) out.costPeriod = period;
      return;
    }
    if (node.widget === 'card') {
      const planType = str(node.title);
      if (!planType) return;
      const current = str(node.subtitle);
      const button = (Array.isArray(node.footerButtons) ? node.footerButtons : []).find(
        (b) => isObj(b) && str(b.taskUri)
      ) as Obj | undefined;
      out.planTypes.push({
        ...(group ? { group } : {}),
        planType,
        ...(current ? { current } : {}),
        waived: !!current && /^waived$/i.test(current),
        ...(button ? { uri: str(button.taskUri) } : {}),
      });
      return;
    }
    const next = node.widget === 'panel' ? str(node.label) ?? group : group;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'widget' || k === 'title') continue;
      walk(v, next, depth + 1);
    }
  };
  walk(root.body, undefined, 0);
  return out;
}

// ---------------------------------------------------------------------------
// A plan type's page: the plans on offer and what each costs
// ---------------------------------------------------------------------------

export interface WorkdayPlanOption {
  plan: string;
  selected: boolean;
  youPay?: string;
  companyPays?: string;
  /** The plan's details page (a GET): per-coverage-level rates, provider. */
  detailsUri?: string;
}

export interface WorkdayPlanOptions {
  planType?: string;
  costPeriod?: string;
  plans: WorkdayPlanOption[];
  /** Present (true) when no plan is selected. */
  waived?: true;
  /** Workday's notes on this choice: what waiving means, which plans exclude
   *  each other. */
  notes?: string[];
  instructions?: string;
}

/** Text of a grid cell: a GET command button's label, or a text widget's value. */
function cellText(cell: unknown): string | undefined {
  if (!isObj(cell)) return undefined;
  if (cell.widget === 'commandButton') return str(cell.label);
  return str(cell.value);
}

function isSelected(cell: unknown): boolean {
  let hit = false;
  eachNode(cell, (n) => {
    if (n.widget === 'checkBoxInput' && /^(select|elect)$/i.test(str(n.label) ?? '') && n.value === true) hit = true;
  }, 10);
  return hit;
}

export function parsePlanOptions(root: unknown): WorkdayPlanOptions | undefined {
  if (!isObj(root)) return undefined;
  let grid: Obj | undefined;
  const notes: string[] = [];
  let instructions: string | undefined;
  eachNode(root.body, (n) => {
    if (!grid && (n.widget === 'chunkedEditGrid' || n.widget === 'grid') && Array.isArray(n.rows) && Array.isArray(n.columns)) {
      grid = n;
    }
    const prop = str(n.propertyName) ?? '';
    if (n.widget === 'text' && /Help_Text|Benefit_Message/.test(prop)) {
      const v = str(n.value);
      if (v && !notes.includes(v)) notes.push(v);
    }
    if (n.widget === 'richTextArea' && /Instruction/i.test(prop) && !instructions) {
      instructions = readRichText(str(n.value) ?? '') || undefined;
    }
  });
  if (!grid) return undefined;

  const columns = (grid.columns as unknown[]).filter(isObj);
  const idFor = (re: RegExp): string | undefined => str(columns.find((c) => re.test(str(c.label) ?? ''))?.columnId);
  const planCol = idFor(/plan/i);
  const selectCol = idFor(/selection|elect/i);
  const payLabel = columns.map((c) => str(c.label) ?? '').find((l) => /^you (pay|contribute)/i.test(l));
  const payCol = idFor(/^you (pay|contribute)/i);
  const companyCol = idFor(/company|employer/i);

  const plans: WorkdayPlanOption[] = [];
  for (const row of grid.rows as unknown[]) {
    if (!isObj(row) || !isObj(row.cellsMap)) continue;
    const cells = row.cellsMap;
    const planCell = planCol ? cells[planCol] : undefined;
    const plan = cellText(planCell);
    if (!plan) continue;
    const detailsUri =
      isObj(planCell) && str(planCell.httpMethod)?.toUpperCase() === 'GET' ? str(planCell.uri) : undefined;
    const youPay = payCol ? cellText(cells[payCol]) : undefined;
    const companyPays = companyCol ? cellText(cells[companyCol]) : undefined;
    plans.push({
      plan,
      selected: selectCol ? isSelected(cells[selectCol]) : false,
      ...(youPay ? { youPay } : {}),
      ...(companyPays ? { companyPays } : {}),
      ...(detailsUri ? { detailsUri } : {}),
    });
  }

  const planType = titleOf(root);
  const costPeriod = costPeriodOf(payLabel);
  return {
    ...(planType ? { planType } : {}),
    ...(costPeriod ? { costPeriod } : {}),
    plans,
    ...(plans.some((p) => p.selected) ? {} : { waived: true as const }),
    ...(notes.length ? { notes } : {}),
    ...(instructions ? { instructions } : {}),
  };
}

// ---------------------------------------------------------------------------
// A plan's details page: the rate table by coverage level
// ---------------------------------------------------------------------------

export interface WorkdayPlanRates {
  plan?: string;
  provider?: string;
  providerUrl?: string;
  rates: Array<{ coverage: string; youPay: string }>;
}

export function parsePlanRates(root: unknown): WorkdayPlanRates {
  const out: WorkdayPlanRates = { rates: [] };
  if (!isObj(root)) return out;
  const plan = titleOf(root);
  if (plan) out.plan = plan;
  eachNode(root.body, (n) => {
    if (n.widget === 'monikerList' && /provider/i.test(str(n.label) ?? '') && !out.provider) {
      const inst = (Array.isArray(n.instances) ? n.instances : []).find(isObj);
      const text = inst ? str(inst.text) : undefined;
      if (text) out.provider = text;
      const target = inst ? str(inst.target) : undefined;
      if (target) {
        let url: string | undefined;
        try {
          url = decodeURIComponent(target);
        } catch {
          url = undefined;
        }
        if (url && /^https?:\/\//i.test(url)) out.providerUrl = url;
      }
    }
    // A rate row: a fieldSet pairing one currency text with one coverage moniker.
    if (n.widget === 'fieldSet' && Array.isArray(n.children)) {
      const kids = n.children.filter(isObj);
      const cost = kids.find((k) => k.widget === 'text' && money(str(k.value)) !== undefined);
      const tier = kids.find((k) => k.widget === 'monikerList' && !str(k.label));
      const coverage = tier
        ? str((Array.isArray(tier.instances) ? tier.instances : []).find(isObj)?.text)
        : undefined;
      const youPay = cost ? str(cost.value) : undefined;
      if (coverage && youPay) out.rates.push({ coverage, youPay });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Elections grids ("Current Benefit Elections and Costs", an event's
// "Elected Coverages") — already parsed by parseTask, mapped here by column
// label so tenant wording differences ("Employee Cost" / "You Pay") hold.
// ---------------------------------------------------------------------------

export interface WorkdayBenefitElection {
  plan: string;
  coverage?: string;
  calculatedCoverage?: string;
  coverageBegins?: string;
  deductionBegins?: string;
  dependents?: string[];
  beneficiaries?: string[];
  youPay?: string;
  companyPays?: string;
}

export interface WorkdayElectionsTable {
  costPeriod?: string;
  elections: WorkdayBenefitElection[];
  /** The grid's footer row (no plan): the per-period totals. */
  totals?: { youPay?: string; companyPays?: string };
}

export function electionsFromGrid(grid: WorkdayGrid): WorkdayElectionsTable {
  const col = (re: RegExp): string | undefined => grid.columns.find((c) => re.test(c));
  const planCol = col(/benefit plan|^plan$/i);
  const coverageCol = col(/^coverage$/i);
  const calcCol = col(/calculated coverage/i);
  const beginCol = col(/coverage begin/i);
  const deductCol = col(/deduction begin/i);
  const depCol = col(/dependent/i);
  const benCol = col(/beneficiar/i);
  const youCol = col(/employee (cost|contribution)|^you (pay|contribute)/i);
  const companyCol = col(/employer|company/i);

  const elections: WorkdayBenefitElection[] = [];
  let totals: WorkdayElectionsTable['totals'];
  const names = (row: WorkdayGrid['rows'][number], column: string | undefined): string[] | undefined => {
    if (!column || !row.cells[column]) return undefined;
    // References name each person exactly; the cell text joins them with ", "
    // (and a trust's name may itself contain a comma).
    const refs = row.references.filter((r) => r.label === column && r.value).map((r) => r.value as string);
    return refs.length ? refs : [row.cells[column]];
  };
  for (const row of grid.rows) {
    const c = row.cells;
    const pick = (column: string | undefined): string | undefined => (column ? c[column] || undefined : undefined);
    const youPay = pick(youCol);
    const companyPays = pick(companyCol);
    const plan = pick(planCol);
    if (!plan) {
      if (youPay || companyPays) totals = { ...(youPay ? { youPay } : {}), ...(companyPays ? { companyPays } : {}) };
      continue;
    }
    const coverage = pick(coverageCol);
    const calculatedCoverage = pick(calcCol);
    const coverageBegins = pick(beginCol);
    const deductionBegins = pick(deductCol);
    const dependents = names(row, depCol);
    const beneficiaries = names(row, benCol);
    elections.push({
      plan,
      ...(coverage ? { coverage } : {}),
      ...(calculatedCoverage ? { calculatedCoverage } : {}),
      ...(coverageBegins ? { coverageBegins } : {}),
      ...(deductionBegins ? { deductionBegins } : {}),
      ...(dependents ? { dependents } : {}),
      ...(beneficiaries ? { beneficiaries } : {}),
      ...(youPay ? { youPay } : {}),
      ...(companyPays ? { companyPays } : {}),
    });
  }
  const costPeriod = costPeriodOf(youCol ?? companyCol);
  return { ...(costPeriod ? { costPeriod } : {}), elections, ...(totals ? { totals } : {}) };
}

/** `$12.5` → `"$12.50"`, `-3` → `"-$3.00"`, with a leading `+` when signed. */
export function formatMoney(n: number, signed = false): string {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : signed ? '+' : ''}$${abs}`;
}

/** now → next as a signed difference, or undefined when either side is not money. */
export function moneyChange(now: string | undefined, next: string | undefined): string | undefined {
  // A side with no cost (a plan added or dropped) counts as $0.
  const a = money(now ?? '$0');
  const b = money(next ?? '$0');
  if (a === undefined || b === undefined) return undefined;
  const d = Math.round((b - a) * 100) / 100;
  return formatMoney(d, true);
}

// ---------------------------------------------------------------------------
// WRITE-SIDE readers. These return flow handles (flow keys, field ids, button
// uris) for the confirm-gated election write in client.ts, and must NEVER be
// returned to a caller: a flow key is a live handle on the user's enrollment.
// They read raw, unredacted pages (the denylist would blank the flow key).
// ---------------------------------------------------------------------------

/** The event date some enrollment pages carry, which the web app echoes back
 *  as `effective` on every POST from them (seen on the contribution page). */
function effectiveOf(root: Obj): string | undefined {
  for (const [k, v] of Object.entries(root)) {
    if (/^effective(date)?$/i.test(k) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v;
  }
  return undefined;
}

function flowHandles(root: unknown): { root: Obj; flowKey: string; pageId: string; effective?: string } | undefined {
  if (!isObj(root) || !isObj(root.body)) return undefined;
  const flowKey = str(root.flowExecutionKey);
  const pageId = str(root.body.id);
  if (!flowKey || !pageId) return undefined;
  const effective = effectiveOf(root);
  return { root, flowKey, pageId, ...(effective ? { effective } : {}) };
}

export interface WorkdayPlanTypeForm {
  flowKey: string;
  pageId: string;
  /** The page's `seamlessSaveCancelUri`: closes the sub-flow afterwards. */
  cancelUri?: string;
  effective?: string;
  rows: Array<{ plan: string; selected: boolean; electId: string; waiveId: string }>;
}

export function parsePlanTypeForm(root: unknown): WorkdayPlanTypeForm | undefined {
  const h = flowHandles(root);
  if (!h) return undefined;
  let grid: Obj | undefined;
  eachNode(h.root.body, (n) => {
    if (!grid && n.widget === 'chunkedEditGrid' && Array.isArray(n.rows)) grid = n;
  });
  if (!grid) return undefined;
  const rows: WorkdayPlanTypeForm['rows'] = [];
  for (const row of grid.rows as unknown[]) {
    if (!isObj(row) || !isObj(row.cellsMap)) continue;
    let plan: string | undefined;
    let electId: string | undefined;
    let waiveId: string | undefined;
    let selected = false;
    for (const cell of Object.values(row.cellsMap)) {
      if (isObj(cell) && cell.widget === 'commandButton' && !plan) plan = str(cell.label);
      eachNode(cell, (n) => {
        if (n.widget !== 'checkBoxInput') return;
        const id = str(n.id);
        if (!id) return;
        if (/\/wd:Elect$/.test(id)) {
          electId = id;
          if (n.value === true) selected = true;
        } else if (/\/wd:Waive$/.test(id)) {
          waiveId = id;
        }
      }, 10);
    }
    if (plan && electId && waiveId) rows.push({ plan, selected, electId, waiveId });
  }
  const cancelUri = str(h.root.seamlessSaveCancelUri);
  return {
    flowKey: h.flowKey,
    pageId: h.pageId,
    ...(cancelUri ? { cancelUri } : {}),
    ...(h.effective ? { effective: h.effective } : {}),
    rows,
  };
}

export interface WorkdayContributionForm {
  flowKey: string;
  pageId: string;
  annualId: string;
  annual?: number;
  effective?: string;
}

/** The "Contribute" page a spending account (HSA, FSA) opens after its plan
 *  is confirmed: Per Paycheck and Annual amount inputs. */
export function parseContributionForm(root: unknown): WorkdayContributionForm | undefined {
  const h = flowHandles(root);
  if (!h) return undefined;
  let field: Obj | undefined;
  eachNode(h.root.body, (n) => {
    if (field || !/Input$/.test(str(n.widget) ?? '')) return;
    const id = str(n.id) ?? '';
    if (/Annual_Contribution$/i.test(id) || /Annual_Contribution/i.test(str(n.propertyName) ?? '')) field = n;
  });
  const annualId = field ? str(field.id) : undefined;
  if (!field || !annualId) return undefined;
  const v = field.value;
  const annual = typeof v === 'number' ? v : money(`$${str(v) ?? ''}`);
  return {
    flowKey: h.flowKey,
    pageId: h.pageId,
    annualId,
    ...(annual !== undefined ? { annual } : {}),
    ...(h.effective ? { effective: h.effective } : {}),
  };
}

/** The landing page's POST buttons — never surfaced by the read path. */
export function parseLandingActions(root: unknown): { save?: string; review?: string } {
  const out: { save?: string; review?: string } = {};
  if (!isObj(root)) return out;
  eachNode(root.body, (n) => {
    if (n.widget !== 'commandButton' || str(n.httpMethod)?.toUpperCase() !== 'POST') return;
    const label = str(n.label) ?? '';
    const uri = str(n.uri);
    if (!uri) return;
    if (/save for later/i.test(label) && !out.save) out.save = uri;
    if (/review and sign/i.test(label) && !out.review) out.review = uri;
  });
  return out;
}

/** "Save Without Submitting?" — the modal Save for Later opens. */
export function parseSaveModal(root: unknown): { flowKey: string; pageId: string; confirmId: string } | undefined {
  const h = flowHandles(root);
  if (!h) return undefined;
  let confirmId: string | undefined;
  eachNode(h.root.body, (n) => {
    if (confirmId || n.widget !== 'checkBoxInput') return;
    const id = str(n.id);
    if (id && (/save without submitting/i.test(str(n.label) ?? '') || /\/wd:Confirm$/.test(id))) confirmId = id;
  });
  return confirmId ? { flowKey: h.flowKey, pageId: h.pageId, confirmId } : undefined;
}

/** "View Summary" — Review and Sign: the electronic signature and the bar. */
export function parseSignForm(
  root: unknown
): { flowKey: string; pageId: string; signatureId: string; bar: { id: string; submit: string } } | undefined {
  const h = flowHandles(root);
  if (!h) return undefined;
  let signatureId: string | undefined;
  let bar: { id: string; submit: string } | undefined;
  eachNode(h.root.body, (n) => {
    if (n.widget === 'checkBoxInput' && !signatureId) {
      const id = str(n.id) ?? '';
      if (/Electronic_Signature/i.test(id) || /^i accept$/i.test(str(n.label) ?? '')) signatureId = id || undefined;
    }
    if (n.widget === 'bpfButtonBar' && !bar) {
      const id = str(n.id);
      const submit = (Array.isArray(n.bpfButtons) ? n.bpfButtons : [])
        .filter(isObj)
        .find((b) => /^submit$/i.test(str(b.label) ?? ''));
      const iid = submit ? str(submit.valueIid) : undefined;
      if (id && iid) bar = { id, submit: iid };
    }
  });
  return signatureId && bar ? { flowKey: h.flowKey, pageId: h.pageId, signatureId, bar } : undefined;
}

export function isSubmittedPage(root: unknown): boolean {
  if (!isObj(root)) return false;
  return /Submitted_Successfully/i.test(str(root.xmlName) ?? '') || /submitted your elections/i.test(titleOf(root) ?? '');
}

export function isSavedPage(root: unknown): boolean {
  if (!isObj(root)) return false;
  return /Save_?for_?Later_?Confirmation/i.test(str(root.xmlName) ?? '') || /save for later confirmation/i.test(titleOf(root) ?? '');
}

/** Workday's `change-summary`: the paired field the web app reports changed
 *  alongside the one it validates (a radio pair, a modal's confirm box). */
export function changeSummaryXml(ref: string, value: string): string {
  const m = /^[\w.$-]+\/wd:(\w+)$/.exec(ref);
  if (!m || !/^[\w.-]*$/.test(value)) throw new Error(`Refusing to build a change summary for field "${ref}".`);
  const el = `wd:${m[1]}`;
  return (
    '<wml:Change_Summary xmlns:wml="http://www.workday.com/ns/model/1.0" xmlns:wd="urn:com.workday/bsvc" ' +
    `xmlns:nyw="urn:com.netyourwork/aod"><${el} Ref="${ref}" Replaced=""><V>${value}</V></${el}></wml:Change_Summary>`
  );
}

/** True when a widget of this kind appears anywhere in the page. */
export function hasWidget(root: unknown, kind: string): boolean {
  let hit = false;
  eachNode(root, (n) => {
    if (n.widget === kind) hit = true;
  });
  return hit;
}

/** Validation errors Workday returned on a flow step, as plain messages. */
export function pageErrors(root: unknown): string[] {
  const out: string[] = [];
  const add = (m: unknown) => {
    const s = typeof m === 'string' ? stripHtml(m).trim() : undefined;
    if (s && !out.includes(s)) out.push(s);
  };
  eachNode(root, (n) => {
    for (const key of ['errors', 'validationErrors']) {
      const list = n[key];
      if (Array.isArray(list)) for (const e of list) add(isObj(e) ? e.message ?? e.text : e);
    }
    if (/^error/i.test(str(n.widget) ?? '')) add(n.message ?? n.text ?? n.value);
  });
  return out;
}
