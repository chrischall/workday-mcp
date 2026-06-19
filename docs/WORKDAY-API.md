# Workday internal web API — capture notes

How workday-mcp reads Workday. Captured live against a production tenant on
`wd5.myworkday.com` (2026-06). **No secrets / no real values are recorded here —
only request shapes and the widget-tree schema.**

## Access model

- Workday has three API surfaces. The **official REST/SOAP API** requires a
  tenant admin to register an OAuth API client + ISU — a consumer/employee
  cannot self-provision it. The **public jobs feed**
  (`/wday/cxs/{tenant}/{site}/jobs`) is a recruiting surface, not personal HR
  data. This MCP uses the **third surface: the employee's own signed-in web
  session.**
- Tenants sit behind corporate SSO (Ping / Okta / Entra) with MFA. There is
  **no server-side login** — every request rides the user's already-authenticated
  `*.myworkday.com` browser tab via the **fetchproxy** bridge (full-fetchproxy
  archetype).
- Per-tenant: the host (`wd5`) and tenant slug are configurable
  (`WORKDAY_HOST` / `WORKDAY_TENANT`). Object/instance ids are **discovered at
  runtime**, never hardcoded.

## Endpoint shapes

- **SPA routes** live under `/{tenant}/d/...` (e.g. `/{tenant}/d/home.htmld`) and
  return the **HTML app shell**, not data. Don't fetch these for data.
- **Data endpoints** return clean JSON (no anti-CSRF guard prefix observed, but
  the client strips one defensively). Key ones:
  - `/{tenant}/inst/<pageCtx>/cacheable-task/<taskId>.htmld` — a task page
    (e.g. the "Benefits and Pay" hub, taskId `2998$43525`). Often a small shell
    that delegates to child cards.
  - `/{tenant}/card/all/<cardId>/<pageCtx>.htmld` — a **data card**. The real
    content. `<pageCtx>` is an **opaque, page-context-bound token** (e.g.
    `39330!CKKz…~*…~`) — NOT constructable; it comes from loading the parent
    task. (The `cacheable-task` token is comparatively stable; the `card/all`
    child token rotates.)
  - `/{tenant}/quickaccess/fetch.htmld?shouldFetchUpcApps=true` — the user's
    pinned apps (a different `widget/children` tree — see Follow-ons).
  - `/{tenant}/get-global-prefs.htmld?feature=<f>` — tiny authenticated JSON;
    used as the healthcheck probe.
- A modern **GraphQL** surface also exists at
  `/wday/pex/graphql/graphql?operation=...` (POST) for the home/PEX layer — not
  yet consumed (see Follow-ons).

## Widget-tree schema (the `cardContentSections` shape — what `parseTask` reads)

Every task/card response is a `root` envelope:

```
root: {
  widget: 'root', title, taskId, tenant, pageContextId, requestUri,
  currentUser: { iid, label, relatedTasksLink: { uri }, selfLink: { uri } },
  accountTasks: [ { label, uri } ],            // page-level related tasks
  header: { excelLink: { uri }, pdfLink: { uri } },
  sessionSecureToken: '…',                      // SECRET — never emitted
  body: {
    widget: 'card',
    cardContentSections: [
      { widget: 'cardContentSection', contentSectionName, contentSectionItems: [ … ] }
    ]
  }
}
```

Leaf widgets inside `contentSectionItems` (at variable nesting depth):

- `text`        → `{ label, value, propertyName }` — a field/value pair.
- `moniker`     → `{ text, instanceId }` — a reference to an entity.
- `monikerList` → `{ label, selfUriTemplate, relatedTasksUriTemplate, instances:[moniker] }`.

### List cards (the common, important case)

For a **list/table card** (`contentSectionName` like `listCardItems`), each
`contentSectionItems[i]` is a **ROW object** whose keys are CLEAN column names:

```
{ label:{text}, value:{text}, secondaryValue:{text}, indicatorLabel:{text},
  task:{monikerList}, onInstance:{monikerList}, relatedTaskInstance:{monikerList},
  uxIcon:{monikerList}, image:{monikerList}, … }
```

- The human datum is the **column widget's `.value`**: row label = `row.label.value`,
  value = `row.value.value`, secondary = `row.secondaryValue.value`.
- **Gotcha (cost us a parser rewrite):** key on the **object key** (`label`,
  `value`), NOT `propertyName` — real propertyNames are namespaced
  (`wd:Label`, `nyw:Value`, `nyw:Task--IS`). The `text` widget's own `.label`
  is the COLUMN name ("Label"/"Value"), not the field name — collecting those
  yields template noise.
- Drill-in references come from the **navigational** columns only
  (`task`, `onInstance`, `relatedTaskInstance`, `quicklinkItem`); `uxIcon`/`image`
  monikerLists are decoration and are skipped.

Validated live: a 3-row benefits cost card parsed to 3 rows, 0 template
mislabels, 3 real values, 3 references.

## Session-expiry detection

An expired session bounces the fetch to the IdP. The client flags sign-out when
the final URL host ≠ the tenant host (cross-origin SSO redirect) or the body is
an HTML login/SAML page (`SAMLRequest` / `pingfederate` markers) rather than the
JSON widget tree, and on 401/403.

## Follow-ons (not in v1)

- **Apps/worklet discovery**: parse `quickaccess/fetch.htmld`'s `widget/children`
  tree (`upcApp` / `configuredAppsItem` / `category` leaves — distinct vocabulary,
  not yet captured) to list launchable apps + their task URIs.
- **GraphQL home** (`/wday/pex/graphql/...`): awaiting actions, inbox count,
  announcements.
- **Typed convenience tools**: `workday_get_payslips`, `workday_get_compensation`,
  `workday_get_benefits` — thin wrappers over `getTask` once each task's launch
  template is captured.
- **Writes** (planned): Workday writes are multi-step business processes, not
  single POSTs — each needs its own capture + a `confirm`-gated `preview()` +
  re-read verification.
