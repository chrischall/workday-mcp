// The durable core of workday-mcp: a parser for Workday's `*.htmld`
// widget-tree JSON.
//
// Every Workday web view — home, a task page, a data card — responds with the
// SAME envelope: a `root` widget carrying page chrome (title, taskId, tenant,
// currentUser, accountTasks, header export links) plus a `body` card whose
// `cardContentSections[]` hold the actual data as nested leaf widgets:
//
//   - `text`        → { label, value }            a field/value pair
//   - `moniker`     → { text, instanceId }        a reference to an entity
//   - `monikerList` → { label, selfUriTemplate, … } a labeled list of monikers
//
// The leaf widgets sit at VARIABLE depth inside each section's items (the real
// tree wraps them in unnamed container objects), so we recurse each section
// subtree and collect leaves rather than assuming a fixed path. This makes the
// parser resilient to per-tenant / per-card structural differences.
//
// SECURITY: the envelope also carries a `sessionSecureToken` (and other
// secret-ish keys). The parser reads ONLY an explicit allowlist of envelope
// fields and the `body` sections — it never walks the root object wholesale —
// so secrets cannot ride out into tool output.

export interface WorkdayField {
  label: string;
  value: string;
}

export interface WorkdayReference {
  /** Field label (from the enclosing monikerList) or the entity's own text. */
  label: string;
  /** Display text of the referenced entity. */
  value?: string;
  /** Opaque Workday instance id — the handle for following the reference. */
  instanceId?: string;
  /** Resolved drill-in path, when a uri template was available. */
  uri?: string;
}

export interface WorkdaySection {
  name: string;
  fields: WorkdayField[];
  references: WorkdayReference[];
}

export interface WorkdayTask {
  title?: string;
  taskId?: string;
  tenant?: string;
  user?: { label?: string; id?: string; relatedTasksUri?: string };
  sections: WorkdaySection[];
  /** Account-level tasks Workday offers on the page (label + uri). */
  relatedTasks: WorkdayReference[];
  /** Export links Workday exposes for the page, when present. */
  export?: { excel?: string; pdf?: string };
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function resolveTemplate(
  template: string | undefined,
  instanceId: string | undefined
): string | undefined {
  if (!template || !instanceId) return undefined;
  return template.replace('{id}', instanceId);
}

type Acc = { fields: WorkdayField[]; references: WorkdayReference[] };

// Columns a list-card row exposes as drill-in references (navigational
// monikerLists). Other monikerList columns (uxIcon / image) are decoration and
// are intentionally skipped so a row's `references` stays meaningful.
const NAV_COLUMNS = ['task', 'onInstance', 'relatedTaskInstance', 'quicklinkItem'];

/** Index a list-card row's direct child WIDGETS by their clean object key
 *  (`label` / `value` / `secondaryValue` / `task` / …). Workday keys row
 *  columns by these clean names while their `propertyName` is namespaced
 *  (`wd:Label`, `nyw:Value`), so we key on the object key, not propertyName.
 *  Returns null when the item exposes no child widgets (not a row). */
function rowColumns(item: Obj): Record<string, Obj> | null {
  const cols: Record<string, Obj> = {};
  for (const [k, v] of Object.entries(item)) {
    if (isObj(v) && str(v.widget)) cols[k] = v;
  }
  return Object.keys(cols).length ? cols : null;
}

/** Try to read one item as a list-card row → a single {label, value} field
 *  (value augmented with the secondaryValue when present). Returns null when
 *  the item has no label/value columns to read. */
function readRow(cols: Record<string, Obj>): WorkdayField | null {
  const labelCol = cols['label'];
  const valueCol = cols['value'];
  if (!labelCol && !valueCol) return null;
  const label = str(labelCol?.value) ?? str(labelCol?.label) ?? '';
  let value = str(valueCol?.value) ?? '';
  const secondary = str(cols['secondaryValue']?.value);
  if (secondary) value = value ? `${value} (${secondary})` : secondary;
  if (!label && !value) return null;
  return { label, value };
}

/** Recursively collect monikers/monikerLists (drill-in references) within a
 *  subtree, ignoring text widgets. Used to pull a list-card row's references
 *  without re-collecting its column text as fields. */
function collectReferences(node: unknown, out: Acc, listLabel?: string, uriTemplate?: string): void {
  if (Array.isArray(node)) {
    for (const n of node) collectReferences(n, out, listLabel, uriTemplate);
    return;
  }
  if (!isObj(node)) return;
  const widget = str(node.widget);
  if (widget === 'text') return; // a column value, not a reference
  if (widget === 'moniker') {
    const instanceId = str(node.instanceId);
    const value = str(node.text);
    out.references.push({
      label: listLabel ?? value ?? '',
      ...(value !== undefined ? { value } : {}),
      ...(instanceId !== undefined ? { instanceId } : {}),
      ...(resolveTemplate(uriTemplate, instanceId) !== undefined
        ? { uri: resolveTemplate(uriTemplate, instanceId) }
        : {}),
    });
    return;
  }
  if (widget === 'monikerList') {
    const label = str(node.label) ?? str(node.propertyName);
    const template = str(node.selfUriTemplate) ?? str(node.relatedTasksUriTemplate);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'widget') continue;
      collectReferences(v, out, label, template);
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'widget') continue;
    collectReferences(v, out, listLabel, uriTemplate);
  }
}

/** Recursively collect leaf data widgets in a non-row (flat field-card)
 *  subtree: `text` → field, `moniker`/`monikerList` → reference. */
function collectFlat(node: unknown, out: Acc, listLabel?: string, uriTemplate?: string): void {
  if (Array.isArray(node)) {
    for (const n of node) collectFlat(n, out, listLabel, uriTemplate);
    return;
  }
  if (!isObj(node)) return;
  const widget = str(node.widget);
  if (widget === 'text') {
    const label = str(node.label) ?? '';
    const value = str(node.value) ?? '';
    if (label || value) out.fields.push({ label, value });
    return;
  }
  if (widget === 'moniker' || widget === 'monikerList') {
    collectReferences(node, out, listLabel, uriTemplate);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'widget') continue;
    collectFlat(v, out, listLabel, uriTemplate);
  }
}

/**
 * Collect a section's data. Each top-level item is either a LIST-CARD ROW
 * (keyed column widgets — read as one {row-label: value} field plus its
 * drill-in references) or a FLAT field/widget subtree (recursively collected).
 */
function collectSection(items: unknown, out: Acc): void {
  if (!Array.isArray(items)) {
    if (isObj(items)) collectFlat(items, out);
    return;
  }
  for (const item of items) {
    if (!isObj(item)) continue;
    const cols = rowColumns(item);
    const row = cols ? readRow(cols) : null;
    if (row) {
      out.fields.push(row);
      // pull only the navigational columns' references (skip uxIcon/image decoration)
      for (const navKey of NAV_COLUMNS) {
        if (cols && cols[navKey]) collectReferences(cols[navKey], out);
      }
    } else {
      collectFlat(item, out);
    }
  }
}

function parseUser(root: Obj): WorkdayTask['user'] {
  const cu = root.currentUser;
  if (!isObj(cu)) return undefined;
  const relatedTasksLink = isObj(cu.relatedTasksLink)
    ? str(cu.relatedTasksLink.uri)
    : undefined;
  const user: NonNullable<WorkdayTask['user']> = {};
  if (str(cu.label)) user.label = str(cu.label);
  if (str(cu.iid)) user.id = str(cu.iid);
  if (relatedTasksLink) user.relatedTasksUri = relatedTasksLink;
  return Object.keys(user).length ? user : undefined;
}

function parseRelatedTasks(root: Obj): WorkdayReference[] {
  const tasks = root.accountTasks;
  if (!Array.isArray(tasks)) return [];
  const out: WorkdayReference[] = [];
  for (const t of tasks) {
    if (!isObj(t)) continue;
    const label = str(t.label);
    const uri = str(t.uri);
    if (label || uri) {
      out.push({ label: label ?? '', ...(uri !== undefined ? { uri } : {}) });
    }
  }
  return out;
}

function parseExport(root: Obj): WorkdayTask['export'] {
  const header = root.header;
  if (!isObj(header)) return undefined;
  const excel = isObj(header.excelLink) ? str(header.excelLink.uri) : undefined;
  const pdf = isObj(header.pdfLink) ? str(header.pdfLink.uri) : undefined;
  if (!excel && !pdf) return undefined;
  return {
    ...(excel !== undefined ? { excel } : {}),
    ...(pdf !== undefined ? { pdf } : {}),
  };
}

function parseSections(root: Obj): WorkdaySection[] {
  const body = root.body;
  if (!isObj(body)) return [];
  const sections = body.cardContentSections;
  if (!Array.isArray(sections)) return [];
  const out: WorkdaySection[] = [];
  for (const sec of sections) {
    if (!isObj(sec)) continue;
    const acc = { fields: [] as WorkdayField[], references: [] as WorkdayReference[] };
    collectSection(sec.contentSectionItems, acc);
    out.push({
      name: str(sec.contentSectionName) ?? '',
      fields: acc.fields,
      references: acc.references,
    });
  }
  return out;
}

/**
 * Parse a Workday `*.htmld` widget-tree response into a flat, secret-free
 * task view. Defensive against malformed input — returns empty sections
 * rather than throwing.
 */
export function parseTask(root: unknown): WorkdayTask {
  if (!isObj(root)) {
    return { sections: [], relatedTasks: [] };
  }
  const task: WorkdayTask = {
    sections: parseSections(root),
    relatedTasks: parseRelatedTasks(root),
  };
  if (str(root.title)) task.title = str(root.title);
  if (str(root.taskId)) task.taskId = str(root.taskId);
  if (str(root.tenant)) task.tenant = str(root.tenant);
  const user = parseUser(root);
  if (user) task.user = user;
  const exp = parseExport(root);
  if (exp) task.export = exp;
  return task;
}
