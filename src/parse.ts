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

/**
 * One row of a Workday LIST card, preserved in full.
 *
 * `fields` (below) keeps the v1 reduction of a row to a single
 * `{label, value}` pair, which is lossy the moment a card has more than two
 * columns — exactly the case for the tables a manager reads (approvals with a
 * due date and a status, a roster with a job title and a location). `cells`
 * keeps EVERY column, keyed by its clean column name, including columns whose
 * datum is a moniker (a worker) rather than text.
 */
export interface WorkdayRow {
  /** Clean column name → display text. Decorative columns are excluded. */
  cells: Record<string, string>;
  /** Drill-in references carried by this row's navigational columns. */
  references: WorkdayReference[];
}

export interface WorkdaySection {
  name: string;
  fields: WorkdayField[];
  /** Full list-card rows. Empty for flat field cards. */
  rows: WorkdayRow[];
  references: WorkdayReference[];
}

/** A Workday `grid` — the real table widget. Most of what a manager reads
 *  (management chains, rosters, time-off lists, approvals) arrives as one. */
export interface WorkdayGrid {
  label: string;
  /** Column labels, in display order. */
  columns: string[];
  /** Rows, each keyed by COLUMN LABEL rather than Workday's opaque columnId. */
  rows: WorkdayRow[];
  /** Rows present in THIS response. */
  rowCount?: number;
  /** Total rows Workday says exist — larger than `rowCount` when chunked. */
  totalRowCount?: number;
  /** Chunking endpoint for the remaining rows, when the grid is paged. */
  pagingUri?: string;
  /** Excel export for the full grid. */
  excel?: string;
}

/** One tab of a worker profile and the drill-in tasks it offers. */
export interface WorkdayProfileSection {
  label: string;
  tasks: WorkdayReference[];
}

/** A worker profile (`compositeView`) — the manager's entry point into a
 *  report's data: sections (Job, Compensation, Performance, …), each listing
 *  named, fetchable tasks. */
export interface WorkdayProfile {
  sections: WorkdayProfileSection[];
}

/** One person in an org chart. */
export interface WorkdayOrgNode {
  name?: string;
  instanceId?: string;
  /** Fetchable worker-profile endpoint for this person. */
  profileUri?: string;
  /** `detailOne` — business title. */
  title?: string;
  /** `detailTwo` — location. */
  location?: string;
  /** `detailThree` — number of reports, as Workday renders it. */
  reportCount?: string;
  /** Workday's own edge label (`ancestor`, `direct`, …). */
  relationship?: string;
  hasChildren?: boolean;
  childrenAndPeersCount?: number;
}

/** An org chart (`hierarchyNavigator`): the chain up, plus the nodes at this
 *  level (direct reports / peers). */
export interface WorkdayOrgChart {
  workerId?: string;
  ancestors: WorkdayOrgNode[];
  nodes: WorkdayOrgNode[];
}

/** Which widget family a page turned out to be. Lets a caller (or a model)
 *  tell "this page has no data" from "this page's data lives in a shape I did
 *  not ask for". */
export type WorkdayPageKind =
  | 'card'
  | 'grid'
  | 'form'
  | 'profile'
  | 'orgchart'
  | 'hub'
  | 'prompt'
  | 'unknown';

/** One parameter a report prompt form is asking for. */
export interface WorkdayPrompt {
  label: string;
  /** The Workday input widget, e.g. `monikerListInput`, `textInput`. */
  type: string;
  required?: boolean;
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
  /**
   * The crawl frontier: data-endpoint uris found inside this page's `body`.
   *
   * Workday container/hub tasks (the shape almost every manager app takes)
   * return a near-empty shell that delegates its real content to child
   * `card/all/...` endpoints whose page-context token is NOT constructable —
   * it only exists inside the parent's response. Collecting them here is what
   * lets `WorkdayClient.crawl` follow a hub down to its actual data.
   * Child cards are ranked first, then other task endpoints.
   */
  childCards: WorkdayReference[];
  /** Which widget family this page is. */
  kind: WorkdayPageKind;
  /** Tables on the page. */
  grids: WorkdayGrid[];
  /** Present when the page is a worker profile. */
  profile?: WorkdayProfile;
  /** Present when the page is an org chart. */
  org?: WorkdayOrgChart;
  /** Navigation a hub/landing page offers (worklets + menu quicklinks). */
  navigation: WorkdayReference[];
  /** Present when the page is a report PROMPT form rather than data: the
   *  parameters it wants before it will return anything. */
  prompts?: WorkdayPrompt[];
}

/** A launchable Workday app from the user's app menu. */
export interface WorkdayApp {
  label: string;
  /** Workday task instance id (e.g. `2998$43525`), resolvable via
   *  `workday_get_task`. May be a shared launcher id for some apps. */
  taskId?: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve a Workday uri template against an instance id.
 *
 * Workday ships THREE dialects and a card mixes them freely: `{id}` on card
 * monikerLists, `[IID]` on org-chart navigator lists, and templates that are
 * already concrete (one uri per instance, no placeholder at all). Handling
 * only `{id}` — as v1 did — silently produced unfetchable uris for the other
 * two.
 */
function resolveTemplate(
  template: string | undefined,
  instanceId: string | undefined
): string | undefined {
  if (!template || !instanceId) return undefined;
  if (template.includes('{id}')) return template.replace('{id}', instanceId);
  if (template.includes('[IID]')) return template.replace('[IID]', instanceId);
  return template; // already concrete
}

/**
 * Decode a moniker's `target` into a fetchable, tenant-relative data path.
 *
 * `target` is a URL-ENCODED ABSOLUTE url pointing at the SPA route, e.g.
 * `https%3A%2F%2Fwd5.myworkday.com%2Facme%2Fd%2Ftask%2F2997%244913.htmld`.
 * It is the most reliable navigation edge Workday exposes — it says exactly
 * where a menu entry goes — but it needs decoding and the `/d/` SPA segment
 * removed before it resolves to JSON rather than the app shell.
 */
function decodeTarget(target: string | undefined): string | undefined {
  if (!target) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  let path = decoded;
  if (/^https?:\/\//i.test(decoded)) {
    try {
      path = new URL(decoded).pathname;
    } catch {
      return undefined;
    }
  }
  if (!path.startsWith('/')) return undefined;
  return path.replace(/^\/([^/]+)\/d\//, '/$1/');
}

/** Append `.htmld` when a uri lacks an extension. Workday hands out most
 *  drill-in uris bare (`/{tenant}/inst/<ctx>/rel-task/<id>`) and every one of
 *  them 404s until the extension is added — verified live. */
function ensureHtmld(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const [pathPart, query] = uri.split('?', 2);
  if (/\.[a-z0-9]+$/i.test(pathPart)) return uri;
  return query ? `${pathPart}.htmld?${query}` : `${pathPart}.htmld`;
}

type Acc = { fields: WorkdayField[]; references: WorkdayReference[]; rows?: WorkdayRow[] };

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

// Row columns that are pure decoration — an icon or an avatar. Excluded from
// both a row's cells and its references so neither reads as data.
const DECORATIVE_COLUMNS = new Set([
  'uxIcon',
  'image',
  'icon',
  'avatar',
  'photo',
  'indicatorIcon',
]);

/** Display text of ONE row column widget, whatever kind it is. A column's
 *  datum lives in a different place per widget kind: `text` keeps it in
 *  `.value`, a `moniker` in `.text`, and a `monikerList` in its instances —
 *  which is why the v1 reader (text columns only) dropped roster rows whose
 *  primary column IS the worker moniker. */
function cellText(col: Obj): string | undefined {
  const widget = str(col.widget);
  if (widget === 'moniker') return str(col.text);
  if (widget === 'monikerList') {
    const instances = col.instances;
    if (Array.isArray(instances)) {
      const texts = instances
        .map((i) => (isObj(i) ? str(i.text) : undefined))
        .filter((t): t is string => !!t);
      if (texts.length) return texts.join(', ');
    }
    return undefined;
  }
  // `text` and any unrecognized widget: take whichever scalar it carries.
  return str(col.value) ?? str(col.text);
}

/** Read one item as a FULL list-card row — every non-decorative column as a
 *  cell, plus that row's own drill-in references.
 *
 *  Returns null when the item is not a row. The discriminator matters: a flat
 *  field card nests each leaf inside its own unnamed wrapper object, which is
 *  structurally indistinguishable from a one-column row. A genuine row either
 *  exposes the canonical `label`/`value` columns or carries at least two
 *  columns, so a lone wrapper stays on the flat path. */
function readRowFull(cols: Record<string, Obj>): WorkdayRow | null {
  const cells: Record<string, string> = {};
  for (const [key, col] of Object.entries(cols)) {
    if (DECORATIVE_COLUMNS.has(key)) continue;
    const text = cellText(col);
    if (text) cells[key] = text;
  }
  const keys = Object.keys(cells);
  if (!keys.length) return null;
  if (!('label' in cells) && !('value' in cells) && keys.length < 2) return null;
  // A row's references come from ANY non-decorative reference column — not
  // just the four canonical navigational names, since real cards key the
  // drill-in by the entity ('worker', 'position', 'organization', …).
  const acc: Acc = { fields: [], references: [] };
  for (const [key, col] of Object.entries(cols)) {
    if (DECORATIVE_COLUMNS.has(key)) continue;
    const widget = str(col.widget);
    if (widget === 'moniker' || widget === 'monikerList' || widget === 'link') {
      collectReferences(col, acc);
    }
  }
  return { cells, references: acc.references };
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
  if (widget === 'link') {
    const uri = str(node.uri);
    if (uri) {
      out.references.push({ label: str(node.label) ?? str(node.text) ?? '', uri });
    }
    return;
  }
  if (widget === 'moniker') {
    const instanceId = str(node.instanceId);
    const value = str(node.text);
    // An explicit `target` beats a template: it is where Workday's own UI
    // sends this entry, whereas a template is only a guess at the entity's
    // canonical page.
    const uri = decodeTarget(str(node.target)) ?? resolveTemplate(uriTemplate, instanceId);
    out.references.push({
      label: listLabel ?? value ?? '',
      ...(value !== undefined ? { value } : {}),
      ...(instanceId !== undefined ? { instanceId } : {}),
      ...(uri !== undefined ? { uri } : {}),
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
  if (widget === 'moniker' || widget === 'monikerList' || widget === 'link') {
    collectReferences(node, out, listLabel, uriTemplate);
    return;
  }
  if (widget && STRUCTURED_WIDGETS.has(widget)) return; // has its own parser
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
    // Full-row extraction runs ALONGSIDE the v1 field reduction below, not
    // instead of it: `fields` keeps its exact v1 semantics for back-compat
    // while `rows` carries the lossless view.
    if (cols && out.rows) {
      const fullRow = readRowFull(cols);
      if (fullRow) out.rows.push(fullRow);
    }
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

// Second path segment of a tenant-relative uri that denotes real DATA, as
// opposed to page furniture. Verified live: `/{tenant}/task/...`,
// `/{tenant}/inst/...` and friends return widget trees, while `/{tenant}/button/...`
// is a command endpoint and `/{tenant}/d/...` is the HTML SPA shell.
const DATA_SEGMENTS = new Set(['task', 'inst', 'cacheable-task', 'card', 'generic-hub']);

/** Is `uri` a fetchable Workday DATA endpoint (not the HTML SPA shell, not an
 *  off-tenant absolute URL, not a command button)?
 *
 *  Workday hands out MOST uris without the `.htmld` extension, and every one
 *  of those 404s until it is appended — so an extension check alone (v1) left
 *  the crawl frontier empty against real responses. Extensionless uris are
 *  accepted only when their segment is known to carry data. */
function isDataEndpoint(uri: string): boolean {
  if (!uri.startsWith('/') || uri.includes('/d/')) return false;
  if (uri.includes('.htmld')) return true;
  const segments = uri.split('?')[0].split('/').filter(Boolean);
  // [tenant, segment, ...] — a bare `/{tenant}/x` is not a data endpoint.
  return segments.length >= 3 && DATA_SEGMENTS.has(segments[1]);
}

const CHILD_CARD_MARKER = '/card/all/';

/**
 * Collect the crawl frontier from a page's `body`: every distinct data-endpoint
 * uri it points at, child `card/all/...` cards first.
 *
 * Scoped to `body` deliberately. The root envelope's `accountTasks` / `header`
 * uris are page chrome ("Change Preferences", the Excel export) already
 * surfaced as `relatedTasks` / `export` — crawling them would burn fetches on
 * navigation furniture. And walking only `body`, taking only the `uri` key,
 * keeps this collector inside the parser's allowlist discipline: no other
 * envelope field is ever read.
 */
function parseChildCards(root: Obj): WorkdayReference[] {
  const body = root.body;
  if (!isObj(body)) return [];
  const found = new Map<string, WorkdayReference>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 40) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    const rawUri = str(node.uri);
    const uri = rawUri && isDataEndpoint(rawUri) ? ensureHtmld(rawUri) : undefined;
    if (uri && !found.has(uri)) {
      found.set(uri, { label: str(node.label) ?? str(node.text) ?? '', uri });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'widget') continue;
      walk(v, depth + 1);
    }
  };
  walk(body, 0);
  const all = [...found.values()];
  const isChildCard = (r: WorkdayReference): boolean => !!r.uri?.includes(CHILD_CARD_MARKER);
  return [...all.filter(isChildCard), ...all.filter((r) => !isChildCard(r))];
}


/** Widget subtrees the flat-field collector must not walk into: each has its
 *  own dedicated parser, and letting `collectFlat` loose in them would rip
 *  their cells out of context as loose label/value noise. */
const STRUCTURED_WIDGETS = new Set([
  'grid',
  'compositeView',
  'compositeList',
  'hierarchyNavigator',
  'landingPage',
]);

/** Collect every widget of `kind` under `node`, depth-bounded. */
function findWidgets(node: unknown, kind: string, depth = 0, out: Obj[] = []): Obj[] {
  if (depth > 40) return out;
  if (Array.isArray(node)) {
    for (const n of node) findWidgets(n, kind, depth + 1, out);
    return out;
  }
  if (!isObj(node)) return out;
  if (str(node.widget) === kind) out.push(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'widget') continue;
    findWidgets(v, kind, depth + 1, out);
  }
  return out;
}

/**
 * Parse Workday's `grid` widget into a real table.
 *
 * Workday keys each row's cells by an opaque `columnId` ("24.1") that means
 * nothing outside the response, so this joins `columns[]` to `rows[].cellsMap`
 * and re-keys every row by the human COLUMN LABEL. `totalRowCount` /
 * `pagingUri` are carried through deliberately: a chunked grid returns only
 * its first page, and a caller that cannot see that would report a partial
 * team as the whole team.
 */
function parseGrid(grid: Obj): WorkdayGrid {
  const columnsRaw = Array.isArray(grid.columns) ? grid.columns : [];
  const idToLabel = new Map<string, string>();
  const columns: string[] = [];
  for (const col of columnsRaw) {
    if (!isObj(col)) continue;
    const id = str(col.columnId);
    const label = str(col.label) ?? id ?? '';
    if (id) idToLabel.set(id, label);
    columns.push(label);
  }
  const rows: WorkdayRow[] = [];
  const rowsRaw = Array.isArray(grid.rows) ? grid.rows : [];
  for (const row of rowsRaw) {
    if (!isObj(row)) continue;
    const cellsMap = row.cellsMap;
    if (!isObj(cellsMap)) continue;
    const cells: Record<string, string> = {};
    const acc: Acc = { fields: [], references: [] };
    for (const [colId, cell] of Object.entries(cellsMap)) {
      if (!isObj(cell)) continue;
      const label = idToLabel.get(colId) ?? colId;
      const text = cellText(cell);
      if (text) cells[label] = text;
      const widget = str(cell.widget);
      if (widget === 'moniker' || widget === 'monikerList' || widget === 'link') {
        collectReferences(cell, acc);
      }
    }
    if (Object.keys(cells).length || acc.references.length) {
      rows.push({ cells, references: acc.references });
    }
  }
  const excel = isObj(grid.excelLink) ? str(grid.excelLink.uri) : undefined;
  const rowCount = typeof grid.rowCount === 'number' ? grid.rowCount : undefined;
  const total = typeof grid.deepRowCount === 'number' ? grid.deepRowCount : undefined;
  const paging = str(grid.chunkingUrl);
  return {
    label: str(grid.label) ?? '',
    columns,
    rows,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(total !== undefined ? { totalRowCount: total } : {}),
    ...(paging ? { pagingUri: paging } : {}),
    ...(excel ? { excel } : {}),
  };
}

function parseGrids(root: Obj): WorkdayGrid[] {
  const body = root.body;
  if (!isObj(body)) return [];
  return findWidgets(body, 'grid').map(parseGrid);
}

/**
 * Parse a worker profile (`compositeView`) into its sections and the named
 * tasks each offers.
 *
 * This is the single richest manager surface: one profile fetch yields dozens
 * of fetchable drill-ins (Job Details, Management Chain, Compensation, Time
 * Off, Performance) that would otherwise be undiscoverable — their uris carry
 * a per-worker context id that exists nowhere else.
 */
function parseProfile(root: Obj): WorkdayProfile | undefined {
  const body = root.body;
  if (!isObj(body)) return undefined;
  const sectionNodes = findWidgets(body, 'compositeViewSection');
  if (!sectionNodes.length) return undefined;
  const sections: WorkdayProfileSection[] = [];
  for (const sec of sectionNodes) {
    const tasks: WorkdayReference[] = [];
    for (const taskNode of findWidgets(sec.taskNodes ?? sec, 'compositeViewTask')) {
      const label = str(taskNode.label) ?? '';
      const uri = ensureHtmld(str(taskNode.uri));
      if (label || uri) tasks.push({ label, ...(uri ? { uri } : {}) });
    }
    sections.push({ label: str(sec.label) ?? '', tasks });
  }
  return { sections };
}

/** Read one `navigatorDetail` node — a person plus their display details. */
function parseOrgNode(detail: Obj): WorkdayOrgNode | null {
  const instanceList = isObj(detail.navigatorInstance) ? detail.navigatorInstance : undefined;
  let name: string | undefined;
  let instanceId: string | undefined;
  let profileUri: string | undefined;
  if (instanceList) {
    const instances = Array.isArray(instanceList.instances) ? instanceList.instances : [];
    const first = instances.find(isObj);
    if (first) {
      name = str(first.text);
      instanceId = str(first.instanceId);
    }
    profileUri = ensureHtmld(
      decodeTarget(str(instanceList.target)) ??
        resolveTemplate(str(instanceList.selfUriTemplate), instanceId)
    );
  }
  const item = findWidgets(detail.navigatorItems ?? [], 'navigatorItem')[0];
  const node: WorkdayOrgNode = {
    ...(name ? { name } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(profileUri ? { profileUri } : {}),
    ...(item && str(item.detailOne) ? { title: str(item.detailOne) } : {}),
    ...(item && str(item.detailTwo) ? { location: str(item.detailTwo) } : {}),
    ...(item && str(item.detailThree) ? { reportCount: str(item.detailThree) } : {}),
    ...(str(detail.relationship) ? { relationship: str(detail.relationship) } : {}),
    ...(typeof detail.hasChildren === 'boolean' ? { hasChildren: detail.hasChildren } : {}),
    ...(typeof detail.childrenAndPeersCount === 'number'
      ? { childrenAndPeersCount: detail.childrenAndPeersCount }
      : {}),
  };
  return Object.keys(node).length ? node : null;
}

/** Parse an org chart (`hierarchyNavigator`): the chain up plus this level. */
function parseOrg(root: Obj): WorkdayOrgChart | undefined {
  const body = root.body;
  if (!isObj(body)) return undefined;
  const nav = findWidgets(body, 'hierarchyNavigator')[0];
  if (!nav) return undefined;
  const ancestorNodes = Array.isArray(nav.ancestors) ? nav.ancestors : [];
  const ancestors = ancestorNodes
    .filter(isObj)
    .map(parseOrgNode)
    .filter((n): n is WorkdayOrgNode => n !== null);
  // The level itself can arrive as a single `navigatorDetail` or a list of
  // them; collect every one that is not already counted as an ancestor.
  const seen = new Set(ancestorNodes.filter(isObj));
  const nodes = findWidgets(nav, 'navigatorDetail')
    .filter((d) => !seen.has(d))
    .map(parseOrgNode)
    .filter((n): n is WorkdayOrgNode => n !== null);
  const workerId = str(nav.workerIid);
  return { ...(workerId ? { workerId } : {}), ancestors, nodes };
}

/**
 * Parse a hub / landing page's navigation menu.
 *
 * An app hub carries no data of its own — its whole value is the list of
 * places it can send you: `landingPageWorklet` entries (label + launchable
 * task id) and `landingPageMenuItem` quicklinks (whose destination lives in a
 * moniker `target`). Without this, a hub parses as an empty page, which is
 * exactly what made 8 of this tenant's 21 apps look broken.
 */
function parseNavigation(root: Obj): WorkdayReference[] {
  const out: WorkdayReference[] = [];
  // A `generic-hub` app (Manager Insights Hub and friends) has NO `body` at
  // all: the whole envelope is {hubName, initialHubTaskUrl, navigationPanel}.
  // `initialHubTaskUrl` is its landing page and needs `.htmld` appended —
  // verified live, the bare form 404s and the suffixed one returns the hub.
  const hubUrl = ensureHtmld(str(root.initialHubTaskUrl));
  if (hubUrl) {
    out.push({ label: str(root.hubName) ?? 'Hub overview', uri: hubUrl });
  }
  if (isObj(root.navigationPanel)) {
    const acc: Acc = { fields: [], references: [] };
    collectReferences(root.navigationPanel, acc);
    for (const ref of acc.references) out.push({ ...ref, label: ref.value ?? ref.label });
  }
  const body = root.body;
  if (!isObj(body)) return out;
  const seen = new Set<string>();
  const push = (ref: WorkdayReference): void => {
    const key = `${ref.label}|${ref.uri ?? ''}|${ref.instanceId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  for (const worklet of findWidgets(body, 'landingPageWorklet')) {
    const label = str(worklet.label);
    const taskId = str(worklet.taskIid);
    if (label || taskId) {
      push({ label: label ?? '', ...(taskId ? { instanceId: taskId } : {}) });
    }
  }
  for (const item of findWidgets(body, 'landingPageMenuItem')) {
    const acc: Acc = { fields: [], references: [] };
    collectReferences(item.link ?? item, acc);
    for (const ref of acc.references) {
      // The quicklink's own text is the menu entry name; the enclosing
      // monikerList is generically labelled "Menu Item Quicklink".
      push({ ...ref, label: ref.value ?? ref.label });
    }
  }
  return out;
}

// Non-`*Input` widgets that are still form controls.
const EXTRA_INPUT_WIDGETS = new Set(['textArea', 'checkBox', 'radioButton', 'selectList']);

function isInputWidget(widget: string): boolean {
  return widget.endsWith('Input') || EXTRA_INPUT_WIDGETS.has(widget);
}

/**
 * Detect a report PROMPT form and list the parameters it wants.
 *
 * A large share of Workday's manager "reports" are parameterised: the GET
 * returns an input form, and results only come back after POSTing prompt
 * values. Such a page has no data to parse, so without this it reports as an
 * empty page — indistinguishable from a genuinely empty result. Naming it a
 * prompt (and saying what it asks for) turns a dead end into a next step.
 */
function parsePrompts(root: Obj): WorkdayPrompt[] | undefined {
  const body = root.body;
  if (!isObj(body)) return undefined;
  const prompts: WorkdayPrompt[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 40) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    const widget = str(node.widget);
    if (widget && isInputWidget(widget)) {
      const label = str(node.label);
      if (label) {
        prompts.push({
          label,
          type: widget,
          ...(node.required === true ? { required: true } : {}),
        });
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'widget') continue;
      walk(v, depth + 1);
    }
  };
  walk(body, 0);
  return prompts.length ? prompts : undefined;
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

/**
 * Fallback for FORM-style detail pages (`fieldSet` / `panel` / `vbox`), which
 * carry no `cardContentSections` at all — the shape every profile drill-in
 * (Job Details, Employment Data, …) actually returns. Without this they parse
 * as a page with zero sections, i.e. as nothing.
 *
 * Structured widgets are skipped by `collectFlat`, so a grid/profile/org page
 * does not get its cells scraped into a bogus flat section here.
 */
function parseFormSection(root: Obj): WorkdaySection[] {
  const body = root.body;
  if (!isObj(body)) return [];
  const acc: Acc = { fields: [], references: [], rows: [] };
  collectFlat(body, acc);
  if (!acc.fields.length && !acc.references.length) return [];
  const title = str(root.title) ?? (isObj(root.title) ? str(root.title.text) : undefined);
  return [
    {
      name: title ?? 'Details',
      fields: acc.fields,
      rows: acc.rows ?? [],
      references: acc.references,
    },
  ];
}

function parseSections(root: Obj): WorkdaySection[] {
  const body = root.body;
  if (!isObj(body)) return [];
  const sections = body.cardContentSections;
  if (!Array.isArray(sections)) return [];
  const out: WorkdaySection[] = [];
  for (const sec of sections) {
    if (!isObj(sec)) continue;
    const acc: Acc = {
      fields: [] as WorkdayField[],
      references: [] as WorkdayReference[],
      rows: [] as WorkdayRow[],
    };
    collectSection(sec.contentSectionItems, acc);
    out.push({
      name: str(sec.contentSectionName) ?? '',
      fields: acc.fields,
      rows: acc.rows ?? [],
      references: acc.references,
    });
  }
  return out;
}

/**
 * Parse the user's app menu (`quickaccess/fetch.htmld`) into a flat list of
 * launchable apps. The tree is a `widget/children` structure whose leaf
 * `configuredAppsItem` nodes carry `label` + `taskIid`; we walk it and dedupe
 * by label (Workday repeats some entries). Defensive against malformed input.
 */
export function parseApps(root: unknown): WorkdayApp[] {
  const apps: WorkdayApp[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!isObj(node)) return;
    if (str(node.widget) === 'configuredAppsItem') {
      const label = str(node.label);
      if (label && !seen.has(label)) {
        seen.add(label);
        // Truthy guard (matches parseTask's field guards) so an empty-string
        // taskIid is omitted rather than emitted as `taskId: ""`.
        const taskId = str(node.taskIid);
        apps.push({ label, ...(taskId ? { taskId } : {}) });
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'widget') continue;
      walk(v);
    }
  };
  walk(root);
  return apps;
}

/** Classify a page by which family actually produced content. Ordered by
 *  specificity: a profile that happens to embed a grid is still a profile. */
function detectKind(parts: {
  cardSections: WorkdaySection[];
  grids: WorkdayGrid[];
  profile?: WorkdayProfile;
  org?: WorkdayOrgChart;
  navigation: WorkdayReference[];
  sections: WorkdaySection[];
  prompts?: WorkdayPrompt[];
}): WorkdayPageKind {
  if (parts.profile) return 'profile';
  if (parts.org) return 'orgchart';
  if (parts.grids.length) return 'grid';
  if (parts.navigation.length) return 'hub';
  if (parts.cardSections.length) return 'card';
  // A page can carry BOTH data and inputs (a hub overview with a filter, say).
  // Real fields win — calling that a prompt would hide the data it already
  // returned. Only a page with no fields at all is a pure prompt form.
  const hasData = parts.sections.some((sec) => sec.fields.length > 0);
  if (hasData) return 'form';
  if (parts.prompts?.length) return 'prompt';
  if (parts.sections.length) return 'form';
  return 'unknown';
}

/**
 * Parse a Workday `*.htmld` widget-tree response into a flat, secret-free
 * task view. Defensive against malformed input — returns empty sections
 * rather than throwing.
 */
export function parseTask(root: unknown): WorkdayTask {
  if (!isObj(root)) {
    return {
      sections: [],
      relatedTasks: [],
      childCards: [],
      kind: 'unknown',
      grids: [],
      navigation: [],
    };
  }
  const cardSections = parseSections(root);
  const grids = parseGrids(root);
  const profile = parseProfile(root);
  const org = parseOrg(root);
  const navigation = parseNavigation(root);
  const prompts = parsePrompts(root);
  // Only fall back to flat-form collection when the page offered no structured
  // content of its own — otherwise a detail page's chrome would shadow it.
  const sections =
    cardSections.length || grids.length || profile || org || navigation.length
      ? cardSections
      : parseFormSection(root);
  const task: WorkdayTask = {
    sections,
    relatedTasks: parseRelatedTasks(root),
    childCards: parseChildCards(root),
    kind: detectKind({ cardSections, grids, profile, org, navigation, sections, prompts }),
    grids,
    navigation,
    ...(prompts ? { prompts } : {}),
    ...(profile ? { profile } : {}),
    ...(org ? { org } : {}),
  };
  // `title` is a string on data cards but a `{ text, widget }` widget on task
  // pages — accept both.
  const title = str(root.title) ?? (isObj(root.title) ? str(root.title.text) : undefined);
  if (title) task.title = title;
  if (str(root.taskId)) task.taskId = str(root.taskId);
  if (str(root.tenant)) task.tenant = str(root.tenant);
  const user = parseUser(root);
  if (user) task.user = user;
  const exp = parseExport(root);
  if (exp) task.export = exp;
  return task;
}
