# Workday internal web API — capture notes

How workday-mcp reads Workday. Captured live against a production tenant on
`wd5.myworkday.com` — the original card/task shapes in 2026-06, the full manager
widget vocabulary in 2026-08. **No secrets / no real values are recorded here —
only request shapes and the widget schema.**

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

## Widget vocabulary — the SEVEN page families

Captured live (2026-08) across a production tenant's manager surfaces. **v1
modelled only family 1**, which is why most app pages parsed as empty.

Every response is a `root` envelope: page chrome (`title`, `taskId`, `tenant`,
`currentUser`, `accountTasks`, `header` export links, **`sessionSecureToken` —
SECRET, never emitted**) wrapping a `body` whose widget decides the family.

### 1. `cardContentSections` — data cards

```
body: { widget:'card', cardContentSections: [ { contentSectionName, contentSectionItems:[…] } ] }
```

Leaf widgets at variable depth: `text` → `{label, value}`, `moniker` →
`{text, instanceId}`, `monikerList` → `{label, selfUriTemplate, instances:[moniker]}`.

**List cards**: each `contentSectionItems[i]` is a ROW object keyed by CLEAN
column names (`label`, `value`, `secondaryValue`, `task`, `onInstance`, …), each
column a widget whose `.value` holds the datum. **Key on the object key, NOT
`propertyName`** — real propertyNames are namespaced (`wd:Label`, `nyw:Value`).
A row's primary datum is often a MONIKER column (the worker), not a text column.
`uxIcon` / `image` columns are decoration.

### 2. `grid` — the real table widget

The shape most manager data arrives in (management chains, rosters, histories).

```
grid: { label, gridType, rowCount, deepRowCount, chunkingUrl, excelLink:{uri},
        columns:[ {widget:'column', columnId:'24.1', label:'Organization'} ],
        rows:   [ {widget:'row', rowIndex, id, cellsMap:{ '24.1': <widget> }} ] }
```

Cells are keyed by the opaque `columnId`; join to `columns[]` to recover the
human label. `deepRowCount > rowCount` means the grid is CHUNKED — only the
first page is present, and `chunkingUrl` serves the rest. Reporting a chunked
grid as complete would understate a team.

### 3. `fieldSet` / `panel` / `vbox` / `hbox` — form-style detail pages

No `cardContentSections` at all. Every profile drill-in (Job Details,
Employment Data, …) is one of these; leaf `text` / `date` / `moniker` widgets
are collected flat.

### 4. `compositeView` — WORKER PROFILE (the richest manager surface)

```
compositeViewSection: { label:'Job', taskNodes:[ compositeViewTask ] }
compositeViewTask:    { label:'Job Details', uri:'/{tenant}/inst/<ctx>/rel-task/<taskId>', contextId }
```

One profile fetch yields a catalog of every drill-in Workday offers for that
person. Observed live: **9 sections / 41 tasks** — Job (Job Details, Employment
Data, Manager History, Management Chain, Organizations, Work Arrangement,
Associate History), Compensation (Compensation, Pay Change History, Total
Rewards), Benefits, Contact, Personal, Performance (Goals, Performance Reviews,
Development Plans), Career (Skills, Job History, Education, Certifications, …),
Feedback, Professional Profile. Their uris embed a PER-WORKER context id that
exists nowhere else — this catalog is the only way to discover them.

### 5. `hierarchyNavigator` — ORG CHART

```
hierarchyNavigator: { workerIid, navigationUri:'/{tenant}/navigable',
                      bundlingUrl, printHandlerUrlTemplate, ancestors:[navigatorDetail] }
navigatorDetail: { relationship, hasChildren, childrenAndPeersCount,
                   navigatorInstance: navigatorList,   // the PERSON
                   navigatorItems: [navigatorItem] }   // their details
navigatorItem:   { detailOne: business title, detailTwo: location, detailThree: report count }
```

`navigatorInstance.selfUriTemplate` is a CONCRETE worker-profile uri — the
handle for drilling into that person.

### 6. `landingPage` — APP HUB

```
landingPageWorklet:  { label, taskIid, workletIid }
landingPageMenuItem: { link: monikerList of quicklink monikers }
```

Carries no data of its own; its value is entirely the list of places it can send
you. A hub parsed without this looks like an empty page.

### 7. `generic-hub` — hub apps

The envelope has **no `body`**: `{ hubName, initialHubTaskUrl, navigationPanel }`.
`initialHubTaskUrl` (+ `.htmld`) is the hub's real landing page.

### Report PROMPT forms (not a data family)

Many manager "reports" GET back an INPUT form — `monikerListInput`, `textInput`,
`checkBoxInput`, `textArea` — and only return results after a POST of prompt
values. These have no data to parse; the parser labels them `kind: 'prompt'` and
lists the parameters rather than reporting an empty page.

## Navigation edges (how to get from one page to the next)

- **`moniker.target`** — a URL-ENCODED ABSOLUTE url, e.g.
  `https%3A%2F%2Fwd5.myworkday.com%2F{tenant}%2Fd%2Ftask%2F2997%244913.htmld`.
  Decode it, drop the `/d/` segment, and it fetches. **The most reliable edge** —
  it is where Workday's own UI sends that entry. Preferred over a template.
- **Templates come in THREE dialects**: `{id}` (card monikerLists), `[IID]`
  (org-chart navigator lists), and ALREADY-CONCRETE (one uri per instance).
  Handling only `{id}` silently produces unfetchable uris for the other two.
- **Most uris arrive WITHOUT `.htmld` and 404 until it is appended.** Verified
  across `inst`, `rel-task` and `task` paths.

## Endpoint shapes

- **SPA routes** `/{tenant}/d/...` return the HTML app shell. Never fetch for data.
- `/{tenant}/quickaccess/fetch.htmld?shouldFetchUpcApps=true` — the app menu.
  `configuredAppsItem` leaves carry `label` + `taskIid`. Live tenant: 21 apps,
  of which **8 share one generic launcher id** that opens a near-empty shell —
  so an app must be resolved by LABEL, and its content reached by crawling.
- `/{tenant}/task/<taskId>.htmld` — constructable task endpoint.
- `/{tenant}/inst/<pageCtx>/cacheable-task/<taskId>.htmld` — a task hub.
- `/{tenant}/card/all/<cardId>/<pageCtx>.htmld` — a data card; `<pageCtx>` is
  page-context-bound and NOT constructable.
- `/{tenant}/inst/<workerCtx>/<workerIid>.htmld` — **worker profile**
  ("View Associate"). The `<workerCtx>` differs per tenant, so it is LEARNED at
  runtime from an org-chart node's concrete profile uri rather than hardcoded.
- `/{tenant}/inst/<ctx>/rel-task/<taskId>.htmld` — a profile drill-in.
- `/{tenant}/generic-hub/page-context-id/<id>.htmld` — a hub landing page.
- `/{tenant}/get-global-prefs.htmld?feature=<f>` — tiny authenticated JSON;
  the healthcheck probe.

### Verified NOT GET-able (do not build on these)

- `/{tenant}/navigable/<iid>` and `/{tenant}/navigable/bundler` — org-chart
  expansion DOWNWARD to direct reports. POST-only; a GET 404s. This is why the
  org chart returns the chain upward but no reports.
- `/{tenant}/print/navigable/c2/<iid>.htmld` — 404.
- `/{tenant}/worklet/<workletIid>` — 404 in both forms.
- `/{tenant}/search.htmld` — returns a `federatedSearchResults` SHELL. Tried
  `q`, `st`, `searchText`, `query`, `text`, `keyword`, `s`: all return the empty
  container, so the query parameter is not one of these (results are likely
  fetched by a separate POST). `searchScopesUri` (`/search-scopes.xml`) 404s.

## Session-expiry detection

An expired session bounces to the IdP. The client flags sign-out when the final
URL host ≠ the tenant host, or the body is an HTML login/SAML page
(`SAMLRequest` / `pingfederate` markers), and on 401/403.

## Security

The parser reads an explicit ALLOWLIST, so `sessionSecureToken` cannot ride out.
The raw escape hatches (`workday_fetch`, `workday_graphql`) return Workday's own
bytes, so they apply the dual — a DENYlist (`src/redact.ts`) covering secret KEY
names plus values whose sibling `label` names government/financial PII.
Verified against 26 captured envelopes, 24 of which carried a live
`sessionSecureToken`: zero leaks through either path.

## Follow-ons (not yet)

- **Inbox / "My Tasks" + global search** — no GET-able `.htmld`; served by the
  GraphQL surface (`/wday/pex/graphql/graphql?operation=…`, POST). The
  `workday_graphql` tool can reach it, but Workday does not publish the
  operations, so the documents must be captured from the browser first.
- **Direct reports** — needs the POST-only `navigable` expansion above, or a
  report run with prompt values.
- **Running prompted reports** — a POST of prompt values. Read-shaped, but a
  POST; needs capture plus a decision on whether it counts as a write.
- **Writes** (planned) — multi-step business processes, not single POSTs; each
  needs its own capture, a `confirm` gate, a dry-run `preview()`, and re-read
  verification.
