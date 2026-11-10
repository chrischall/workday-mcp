// Report prompt forms and dashboards (landing-page groups).
//
// `parse.ts`' allowlist rule applies: these readers copy named fields off the
// widgets they recognise and never walk the envelope wholesale, so
// `sessionSecureToken` cannot ride out. The flow key is returned for the
// client to post back and is never put into tool output.

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Depth-bounded walk over every object under `node`. Skips the keys that
 *  hold secrets so a visitor can never see them. */
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

/** One value currently set on a prompt. */
export interface ReportPromptValue {
  text: string;
  /** The selected instance, for list prompts. */
  instanceId?: string;
}

/** One parameter of a report's prompt form. */
export interface ReportPrompt {
  /** Workday's id for the field — names it in flow POSTs. */
  id: string;
  label: string;
  /** The input widget, e.g. `monikerListInput`, `dateInput`. */
  widget: string;
  required: boolean;
  /** Addresses the prompt-search endpoint, for list prompts. */
  contextId?: string;
  values: ReportPromptValue[];
}

export interface ReportPromptForm {
  /** The prompt page's OK: `_eventId_submit=<okId>` runs the report. */
  okId: string;
  flowKey?: string;
  prompts: ReportPrompt[];
}

/**
 * Read a report's prompt form: the parameters it asks for and what each is
 * set to now (reports often arrive with defaults filled in). Undefined when
 * the page has no inputs — the report ran on the GET.
 */
export function parseReportPrompts(root: unknown): ReportPromptForm | undefined {
  if (!isObj(root) || !isObj(root.body)) return undefined;
  const okId = str(root.body.id);
  const prompts: ReportPrompt[] = [];
  walk(root.body, (o) => {
    const widget = str(o.widget);
    const id = str(o.id);
    const label = str(o.label);
    if (!widget || !id || !label || !/Input$/.test(widget)) return;
    const values: ReportPromptValue[] = [];
    if (Array.isArray(o.instances)) {
      for (const i of o.instances) {
        const text = isObj(i) ? str(i.text) : undefined;
        if (!text) continue;
        const instanceId = isObj(i) ? str(i.instanceId) : undefined;
        values.push({ text, ...(instanceId ? { instanceId } : {}) });
      }
    } else if (typeof o.value === 'boolean' || typeof o.value === 'number') {
      values.push({ text: String(o.value) });
    } else if (str(o.value)) {
      values.push({ text: o.value as string });
    }
    const contextId = str(o.contextId);
    prompts.push({ id, label, widget, required: o.required === true, ...(contextId ? { contextId } : {}), values });
  });
  if (!okId || !prompts.length) return undefined;
  const flowKey = str(root.flowExecutionKey);
  return { okId, ...(flowKey ? { flowKey } : {}), prompts };
}

/**
 * The validation errors a prompt submit came back with, each prefixed with
 * the prompt it belongs to. Workday returns the prompt page again rather than
 * failing the request: errors sit in `unassociatedErrorNodes` (keyed to a
 * field by `nodeId`) or in an input's own `errorNodes`. Warnings are dropped.
 */
export function parseReportErrors(root: unknown, prompts: ReportPrompt[]): string[] {
  const byId = new Map(prompts.map((p) => [p.id, p.label]));
  const out: string[] = [];
  const add = (err: unknown, label?: string): void => {
    if (!isObj(err) || str(err.type) === 'WARNING') return;
    const message = str(err.message);
    if (!message) return;
    const field = label ?? byId.get(str(err.nodeId) ?? '');
    out.push(field ? `${field}: ${message}` : message);
  };
  if (isObj(root) && Array.isArray(root.unassociatedErrorNodes)) {
    for (const e of root.unassociatedErrorNodes) add(e);
  }
  if (isObj(root)) {
    walk(root.body, (o) => {
      if (!Array.isArray(o.errorNodes)) return;
      for (const e of o.errorNodes) add(e, str(o.label) ?? byId.get(str(o.id) ?? ''));
    });
  }
  return out;
}

export interface DashboardTab {
  label: string;
  taskId: string;
}

/** A dashboard's tabs (`landingPageGroup` → `landingPageTab`). Each tab is
 *  its own landing page, fetched as `/task/<taskId>`. */
export function parseDashboardTabs(root: unknown): DashboardTab[] {
  const tabs: DashboardTab[] = [];
  if (!isObj(root)) return tabs;
  walk(root.body, (o) => {
    if (o.widget !== 'landingPageTab') return;
    const taskId = str(o.taskIid);
    if (taskId) tabs.push({ label: str(o.label) ?? '', taskId });
  });
  return tabs;
}

export interface DashboardWorklet {
  label: string;
  /** The report the worklet shows — runnable with `workday_run_report`. */
  reportId: string;
}

export interface DashboardLink {
  section?: string;
  label: string;
  reportId: string;
}

/** The task id in a Workday task path (`/acme/task/1422$6216`, any suffix). */
function taskIdOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  return /\/task\/([^/.?#]+)/.exec(p)?.[1];
}

/**
 * One dashboard landing page: its worklets and its menu links.
 *
 * Every worklet carries the SAME generic launcher `taskIid`; the report it
 * shows is its `workletIid` (verified live). Menu links are either GET
 * `commandButton`s (`button.uri` = `/task/<id>`) or quicklink monikers whose
 * `target` is a URL-encoded task url. POST command buttons are actions, not
 * reports, and are skipped.
 */
export function parseDashboardTab(root: unknown): { worklets: DashboardWorklet[]; links: DashboardLink[] } {
  const worklets: DashboardWorklet[] = [];
  const links: DashboardLink[] = [];
  if (!isObj(root)) return { worklets, links };
  walk(root.body, (o) => {
    if (o.widget !== 'landingPageWorklet') return;
    const reportId = str(o.workletIid);
    if (reportId) worklets.push({ label: str(o.label) ?? '', reportId });
  });
  walk(root.body, (o) => {
    if (o.widget !== 'landingPageMenuGroup') return;
    const section = str(o.label);
    walk(o.landingPageMenuItems, (item) => {
      if (item.widget !== 'landingPageMenuItem') return;
      const button = isObj(item.button) ? item.button : undefined;
      if (button) {
        const method = str(button.httpMethod) ?? 'GET';
        const reportId = method === 'GET' ? (str(button.taskId) ?? taskIdOf(str(button.uri))) : undefined;
        const label = str(button.label);
        if (reportId && label) links.push({ ...(section ? { section } : {}), label, reportId });
        return;
      }
      walk(item.link, (m) => {
        if (m.widget !== 'moniker') return;
        const reportId = taskIdOf(str(m.target)) ?? taskIdOf(str(m.uri));
        const label = str(m.text);
        if (reportId && label) links.push({ ...(section ? { section } : {}), label, reportId });
      });
    });
  });
  return { worklets, links };
}
