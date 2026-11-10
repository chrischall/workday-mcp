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

## Review and promotion season (captured 2026-10)

All plain GETs unless noted, and every hop is matched by LABEL:

- **Your team.** Org-chart expansion downward is POST-only (below), but your own
  profile's **"Organizations"** task has a grid **"Manager/Leader of These
  Organizations"** (columns Organization Role / Type / Organization). Each
  `Supervisory` row's Organization moniker opens the org's own `compositeView`
  profile, whose **"Members"** task is a grid of Associate monikers
  (`247$…` worker ids with concrete profile uris) plus Associate ID, Position,
  Email, Phone, Location. Grid cells are LABELLED by their column, so
  "Organization Role" matches a naive `/organization/` — pick the reference
  whose text equals the "Organization" cell.
- **Performance reviews.** Profile → "Performance Reviews" is a grid per status
  ("Completed", …): Review moniker, period start/end, Manager Rating, and two
  `commandButton` cells — **"View Review"** (`/inst/<review>/rel-task/2997$1498`,
  a GET) and "Create Review PDF" (`/button/...`, a command — never follow it).
- **A review's contents.** "View Printable Employee Review" is a `taskWizard`;
  each `taskWizardSection.uri` (`/task-wizard/<ctx>/<taskId>/context/<id>`) is
  GET-able. Sections hold the reviewer's EDIT widgets with their current
  values: `richTextAreaInput` comments, `dropDownSelectList` ratings (the
  selection is `selectedIds` → option `id`, not a flag on the option), panels
  "Manager Summary" / "Employee Summary", and `editPanelList.panels` for
  repeating goals and beliefs. Empty numerics arrive as `0`.
- **Feedback.** Profile → "View Feedback Received" is a grid whose Feedback and
  Badge columns sit inside a **`columnGroup`** — its own `columns` carry the
  ids the cells are keyed by. Feedback text is `compactRichTextArea` HTML.
- **Request forms (e.g. a promotion consideration form).** A Workday *Request*
  questionnaire. The questionnaire object itself is security-gated
  (`/inst/3$34469/<iid>` returns a `System_Error` without the coordinator
  role), so its form is only reachable inside the **Create Request** flow:
  1. `GET /{tenant}/task/2997$12683.htmld` — the delivered Create Request task;
     returns the prompt page with `flowExecutionKey`, `promptUriTemplate`, a
     `monikerListInput` "Request Type" (`id`, `contextId`), and `body.id`.
  2. `POST /{tenant}/prompt/<contextId>/<id>.htmld` — form-urlencoded
     `_flowExecutionKey`, `_eventId_prompt=<id>`, `q=<search>` → `{items:[{instanceId,text}]}`.
  3. `POST /{tenant}/flowController.htmld` — `_eventId_add=<id>`, `<id>=<iid>`,
     `<iid>_DID/_IID/_PV/_V` → a `changeSummary`.
  4. `POST flowController` — `_eventId_submit=<body.id>`: the prompt's OK → the form.
  5. `POST flowController` — `_eventId_cancel=Cancel` abandons the flow.

  Every POST carries `sessionSecureToken` in the body AND a
  `Session-Secure-Token` header, plus a `clientRequestID`. **`_eventId_submit`
  is also how a loaded form is submitted**, so it may only ever be sent while
  the current page is the prompt — a loaded form carries a `bpfToolbar` /
  `bpfButtonBar` (Submit `934$20`, Save for Later `934$14`). Verified live: a
  flow abandoned after step 4 leaves nothing under My Requests / Requests In
  Progress.

  The form: a `panel` per question holding a `richTextArea` whose id contains
  `Question_Body` (bold title, help text, and a trailing " (Required)" — there
  is no required flag), plus a text, date AND number answer input of which all
  but the one in use carry `hideAdvice: "ALWAYS"`; choice questions add a
  `radioButtonSelectList`. Instructions are the `richTextArea` whose id
  contains `Questionnaire_Instructions`.

### Inbox, goals, dashboards (captured 2026-10)

- **Inbox / My Tasks is a plain GET JSON API**, not GraphQL-only:
  `GET /{tenant}/internalapi/internalapi/inbox/v2/{tenant}/inboxItems?category=Actions&offset=0&limit=100`
  (`category=Archive` for completed items) → `{ total, data: [ { relatedItem:
  {title, subtitle, createdDate, effectiveDate, itemType:{descriptor}},
  taskToExecute: {label, uri}, relatedTasks: [{label, uri}], status: {starred} } ] }`.
  It needs header `Session-Secure-Token` set to the token in
  `GET /{tenant}/boot-config` → `appRoot` (a JSON STRING) → `sessionSecureToken`.
  That is a different token from the `.htmld` envelope's; with the envelope
  token the API answers with the HTML app shell. `taskToExecute.uri` is a
  `/d/` SPA uri whose data endpoint opens read-only. Notifications are not
  under this endpoint (`category=Notifications` silently returns Actions).
  `GET /{tenant}/unifiedinbox/actioncount/<id>.htmld` returns just the counts.
- **Goals** (profile → Goals) render as `tabContainer` → `tabContent`
  ("Individual Goals", "Archived Goals", "Organization Goals") → `card`
  widgets: `title`, `headerIndicatorLabel` (status), `contentUri` (a
  `/card/all/...` data card with the detail), `footerButtons[].taskUri`.
- **Dashboards.** `landingPageGroup` → `landingPageTab` (`taskIid` is the
  tab's task). Every `landingPageWorklet` on a dashboard shares the generic
  launcher `taskIid` (`3001$26` here); its report is `GET /task/<workletIid>`.
  Some return a grid, many are prompt reports, a few are permission-gated
  (`System_Error`).
- **My Requests** — delivered task `3005$4617`: a grid of Request, Type,
  Request ID, Description, Status, Resolution, Initiation / Completion Date.

### Running reports, and dashboards (captured 2026-11)

- **A report is a task** (`/{tenant}/task/<id>.htmld`; custom reports are
  `1422$…`, delivered ones `2997$…`). Some answer the GET with their result
  (`facetSearchResult` / a `grid`) and no flow. Others answer with a PROMPT page:
  `flowExecutionKey`, `body.id` (the prompt's OK) and `*Input` widgets, often
  with defaults already in `instances`.
- **Running a prompt report** is the Create Request dance on the report's own
  flow, all form-urlencoded POSTs carrying `_flowExecutionKey` and
  `sessionSecureToken`:
  1. remove a default: `POST /flowController.htmld` `_eventId_remove=<promptId>`,
     `<promptId>=<instanceId>`;
  2. search: `POST /prompt/<contextId>/<promptId>.htmld` `_eventId_prompt=<promptId>`,
     `q=<text>` → `{items:[{instanceId,text}]}` (no `q` = browse; an empty
     list means nothing is open to you);
  3. add: `_eventId_add=<promptId>`, `<promptId>=<iid>`, `<iid>_DID=<text>`,
     `<iid>_IID`, `<iid>_V=1`, `<iid>_PV=1`;
  4. OK: `_eventId_submit=<body.id>` → the result page (grid + `header.excelLink`).
  A rejected prompt returns 200 with `unassociatedErrorNodes:[{nodeId, message,
  type}]` (`nodeId` = the prompt's id) — e.g. a default org outside the user's
  security. The client always sends `_eventId_cancel` afterwards and refuses a
  page that carries a `bpfButtonBar` (a business-process form, where OK submits).
- **A task Workday will not run** answers 200 with an XML
  `<wml:System_Error><wml:Message>…` body, not JSON (e.g. a comp-review
  worklet when no review event is open). The client surfaces the message.
- **Excel export** is async: `GET <excelLink.uri>?<requestParameters>` →
  `{docReadyUri}`, then `GET /doc-ready/….xlsx` → the XLSX bytes. The bridge
  carries text bodies only (binary would need fetchproxy's `download`
  capability), so the tools return the parsed rows instead.
- **Dashboards** are apps in the menu (`configuredAppsItem`, e.g. "Year End
  Dashboard"). The page is a `landingPageGroup` of `landingPageTab`s (each
  `/task/<taskIid>`) or a single `landingPage`. Worklets: the report is
  `workletIid`. Menu groups ("Links to Reports"): `landingPageMenuItem.button`
  is a `commandButton` with `taskId`/`uri` and `httpMethod: GET`.
- **Search** (`/{tenant}/search.htmld?q=`) is still only a shell; results come
  from `GET /wday/pex/fs/{tenant}/fs/v2/init?q=` sent with the `boot-config`
  token, `Session-Secure-Token` and `X-WD-PEX-SEARCH-CORRELATION-ID` headers —
  replaying it from page JS still gets 400, so something else is required.
  Reports therefore resolve by id, URL, or a dashboard's worklets/links.

### Giving and requesting feedback (captured 2026-11, up to Submit)

Delivered tasks, the same ids on every tenant: **Give Feedback** `2997$3067`
and **Get Feedback on Associate** `2997$2976` open with an associate prompt
(the report-prompt dance: `_eventId_prompt` search, `_eventId_add`, then the
prompt's `_eventId_submit=<body.id>`); **Get Feedback on Self** `2997$3241`
opens straight on its form. "Feedback on My Team" (`3005$782`) is a report.

On the form (ids are per page load — find fields by label):
- feedback text: `richTextAreaInput` "Feedback" → `_eventId_validate=<id>`,
  `<id>=<p>…</p>` → `changeSummary` (`update`).
- badge: `dropDownSelectList` "Badge"; options carry `instanceId` →
  `_eventId_add=<listId>`, `<listId>=<iid>`, `<iid>_DID`, `<iid>_IID`.
- people to ask: `monikerListInput` "Who do you want to request feedback
  from?" and the "Feedback Template" prompt — prompt search + `_eventId_add`
  (with `_V`/`_PV`) → `changeSummary` (`addChild` instances). Choosing a
  template also `removeChild`s the question rows and `addChild`s its own, each
  a `richTextAreaInput` `…/wd:Feedback_Question` with the question as `value`.
- a custom question: `_eventId_add=<editPanelList id>` → `changeSummary`
  whose new panel carries the `…/wd:Feedback_Question` field id; then validate
  it like the feedback text. A template's questions are the same editable
  fields, so a template question with a `[BLANK]` placeholder (the live
  "Aspiring Leader" has `[ENTER BEHAVIOR]`) is filled by validating its field
  with the rewritten HTML — Workday acknowledges it with a `changeSummary`.
- visibility ("Show my name?", "Make Feedback Anonymous", the "Feedback
  Sharing" radio's three checkboxes, expiration date) is `hideAdvice: ALWAYS`
  on this tenant: the form submits its defaults, so the preview states them.
  Hidden or not, the sharing checkboxes are settable: `_eventId_validate=<id>`,
  `<id>=1` (`true` gets an XML System_Error) → `changeSummary` that sets the
  chosen one and clears the other two (and makes the template optional when
  confidential). Get Feedback on Associate's prompt offers only My Team and
  your manager / supervisory-org hierarchy — a peer, a skip-level or your own
  manager returns no match.
- commit: the same `bpfButtonBar` as a request — `_eventId_add=<barId>`,
  `<barId>=934$20` (Submit; `934$14` is Save for Later), `_DID`, `_IID`, then
  `_eventId_submit=<body.id>`. Cancel is `_eventId_cancel=Cancel`.

### Benefits and open enrollment (captured 2026-11)

All plain GETs, every hop matched by LABEL:

- **Your Benefits catalog.** The envelope's `currentUser.relatedTasksLink`
  (`/inst/<you>/rel-tasks`) is a `relatedTasks` widget: nested
  `taskGroups[]` → `tasks[]` of `{label, uri, folder, view}`. The **Benefits**
  folder holds "View My Current Benefit Elections", "View My Benefit Election
  History", "View My Beneficiaries", "View Dependents" (`view: true`) and
  "Change Benefits" (`view: false` — starts a life-event process; never
  fetched). `view` is Workday's own read/action flag.
- **Current elections.** The elections task is a card deck (one `card` per
  plan, `title` = plan type, `subtitle` = plan). Its **"View as Grid"**
  (a GET `commandButton`) is one `grid` "Current Benefit Elections and Costs":
  Benefit Plan, Coverage / Deduction Begin Date, Coverage, Calculated
  Coverage, Dependents, Beneficiaries, Employee Cost and Employer Contribution
  (each "(Per Pay Period (Semi-Monthly))"). The last row has no plan — it is
  the totals. Dependents/Beneficiaries cells join names with ", "; the row's
  references name each one exactly.
- **An open event** is an inbox item whose type is "Change Benefits for …"
  and whose task is "Open" (the same type with task "To Do" is a leftover
  step such as dependent documentation). Its `taskToExecute` GET is
  `Benefits_Enrollment_Inbox`: a `richTextArea`
  (`wd:EventTypeWithStartandEndDates`) reading
  "USA Annual Enrollment 10/26/2026-11/08/2026" — the window — and a GET
  `commandButton` "Let's Get Started" (`actionId: view`).
- **"View Details"** on that inbox item ("View Event", `2997$3463`) has grids
  "Elected Coverages" (same columns as the current-elections grid, with
  NEXT year's costs — last year rolled over until changed), "Waived
  Coverages", "Beneficiary Designations" and "Process History".
- **"Let's Get Started"** → `Benefits_Enrollment_Landing_Page`: a
  `stylizedHeader` with the projected total, then `panel`s ("Health Care and
  Accounts", "Insurance", "Additional Benefits") of `card`s — `title` = plan
  type, `subtitle` = current plan or "Waived", `footerButtons[0]` "Manage" /
  "Enroll" with a GET `taskUri`. The footer `commandButtonList` holds
  **"Save for Later" and "Review and Sign" — POSTs; never sent.**
- **A plan type's page** (the card's `taskUri`) is `mode: EDIT` with a
  `flowExecutionKey`, but a GET of it saves nothing: only its "Confirm and
  Continue" (a POST) would. It holds a **`chunkedEditGrid`** (not `grid` —
  `parseTask` does not read it) "Plans Available": `columns[]` map
  `columnId` → label (Benefit Plan, Selection, "You Pay" or "You
  Contribute", Company Contribution); each `rows[].cellsMap` has the plan as a
  GET `commandButton` (label = plan, uri = its details page), the selection as
  `checkBoxInput`s "Select" / "Waive" (`value: true` on the chosen one), and
  the costs as text. `maxLengthValueRow` / `maxWordLengthValueRow` are layout
  hints that duplicate a row — not plans. Notes are `text` widgets
  `wd:Help_Text` and `wd:Benefit_Message` (which plans exclude each other);
  instructions are `richTextArea` `wd:Enrollment_Instructional_Text`.
- **A plan's details** (`/inst/<plan>/rel-task/2998$43660`): a
  "Provider Website" `monikerList` (URL-encoded `target`), and a `panelList`
  of rate rows — each a `fieldSet` pairing a `wd:Formatted_Currency` text with
  a coverage-level `monikerList` ("Associate + Child(ren)").
- **Verified live:** after every one of these pages was read, Benefit
  Election History still showed the event "Not Started" and no election
  changed. **But opening a plan type's page is not invisible:** the web app
  afterwards badged every opened plan-type card "Reviewed". That is
  Workday's own progress marker, not an election.

### Making an election (captured 2026-11, from the user's own browser)

Implemented by `workday_update_benefit_enrollment` (`planBenefitUpdate` /
`applyBenefitUpdate`), confirm-gated.

Waiving one plan type, then Save for Later. Every POST carries
`sessionSecureToken` (body) and `_flowExecutionKey` from the page just
loaded; row ids (`582`) and body ids are renumbered on every load.

1. `GET` the plan type's page (the landing card's `taskUri`).
2. `POST /{t}/flowController.htmld` — `_eventId_validate=<row>/wd:Waive`,
   `<row>/wd:Waive=1`, plus a `change-summary` XML of the paired radio
   (`<wd:Elect Ref="<row>/wd:Elect"><V>0</V></wd:Elect>`). Selecting a plan is
   the same with `wd:Elect=1`. → `changeSummary` of `update`s.
3. `POST flowController` — `_eventId_submit=<page body id>`: **Confirm and
   Continue**. → `slimConclusion`; the choice is now held on the event
   (the landing page's projected cost changes) but nothing is submitted.
4. `POST /{t}/seamless/cancel/task:<task>,instance:<inst>,created:<ms>.htmld`
   — the page's `seamlessSaveCancelUri`, closing the sub-flow (`{"result":"Ok"}`).
5. **Save for Later**: `POST` the landing page's "Save for Later" button uri
   (`/{t}/button/<ctx>/38/<n>.htmld`, empty body) → a "Save Without
   Submitting?" modal; then `POST flowController` — `_eventId_submit=<modal
   body id>` with change-summary `<wd:Confirm Ref="<id>/wd:Confirm"><V>1</V>`
   → "Save For Later Confirmation": the draft's Submit Elections By date,
   total cost, and Elected / Waived / Beneficiary grids.
   **A contribution amount (HSA, FSA)** adds a second page: step 3's
   `_eventId_submit` returns a "Contribute" page (`currencyInput`s Per
   Paycheck / Annual, a Maximum Annual Amount, a Summary with the company
   contribution, and the plan's limits in its instructions). Then
   `POST flowController` — `_eventId_validate=<id>/wd:Annual_Contribution`,
   `<id>/wd:Annual_Contribution=7800`, `effective=2027-01-01-08:00` →
   `changeSummary` (per-paycheck recalculated); then `_eventId_submit=<body
   id>` ("Save") → `slimConclusion`, then the seamless cancel. Every POST on
   this page carries the event's `effective` date.
6. **Review and Sign** — `POST` the landing page's "Review and Sign" button
   uri (`/{t}/button/<ctx>/32/<n>.htmld`, empty body) → "View Summary": a
   `chunkedEditGrid` of Selected Benefits, Waived Benefits, Total Benefits
   Cost, the Electronic Signature text, and a `bpfButtonBar`.
7. **Sign** — `POST flowController` —
   `_eventId_validate=<id>/wd:Employee_Enrollment_Event_Electronic_Signature`,
   `<id>/wd:Employee_Enrollment_Event_Electronic_Signature=1` ("I Accept").
8. **Submit** — the same `bpfButtonBar` pattern as a request:
   `_eventId_add=<barId>`, `<barId>=934$20`, `934$20_DID=Submit`,
   `934$20_IID=934$20` → `changeSummary`; then `_eventId_submit=<body id>`
   → `Benefits_Enrollment_Submitted_Successfully_View` ("You've submitted
   your elections", effective date, final day to update). Captured live
   2026-11-06 submitting the user's own 2027 elections at their request.


### Revising a request (captured 2026-10)

An open request is the inbox's **"Revise Request"** task
(`/{tenant}/inst/<requestIid>/rel-task/2997$12874`). A GET returns the
questionnaire with its saved answers (text in the visible `textAreaInput`'s
`value`; a choice as the radio list's `selectedIds`, options also flagged
`selected`) plus a `bpfButtonBar` (Submit `934$20`, Save for Later `934$14`),
the page `body.id` and a `flowExecutionKey`. **Field ids are renumbered on
every page load**, so a write posts to the ids of the page it just read. The
web app's save, captured from the user's own Save for Later:

1. text answer → `_eventId_validate=<fieldId>`, `<fieldId>=<text>`
2. choice answer → `_eventId_add=<fieldId>`, `<fieldId>=<optionIid>`,
   `<iid>_DID=<text>`, `<iid>_IID`, `<iid>_PV=1`, `<iid>_V=1`
   (`_eventId_validate` on a radio list returns `System_Error`)
3. the action → `_eventId_add=<barId>`, `<barId>=<buttonIid>`,
   `<buttonIid>_DID=<label>`, `<buttonIid>_IID=<buttonIid>`
4. commit → `_eventId_submit=<body.id>`

Steps 1–3 each return a `changeSummary`; without step 4 nothing is saved.
`_eventId_cancel` on a GET-opened revise flow returns `Application_Error` —
leave such a flow to expire.

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

- **Global search** — served by `/wday/pex/fs/{tenant}/fs/v2/init` (see
  "Running reports" above), which still refuses a replayed request.
- **Direct reports** — solved without the POST-only `navigable` expansion: see
  "Review and promotion season" above (profile → Organizations → Members).
- **Writes** (planned) — multi-step business processes, not single POSTs; each
  needs its own capture, a `confirm` gate, a dry-run `preview()`, and re-read
  verification.
