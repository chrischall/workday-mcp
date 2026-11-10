# workday-mcp — contributor notes

Read-only MCP server for Workday, on the chrischall fleet skeleton
(`@chrischall/mcp-utils` + `@fetchproxy/server`). Full-fetchproxy archetype:
every request rides the user's signed-in `*.myworkday.com` tab.

## Architecture

- `src/parse.ts` — **the durable core.** Parses Workday's `*.htmld` widget-tree
  JSON into a flat, secret-free `WorkdayTask`, tagged with a `kind`. Handles all
  seven page families: data cards (flat + list rows), `grid` tables,
  `fieldSet`/`panel` detail pages, `compositeView` worker profiles,
  `hierarchyNavigator` org charts, `landingPage` hubs, and report prompt forms.
  Row objects are keyed by clean column names (`label`/`value`) whose
  `propertyName` is namespaced like `wd:Label` — key on the object key, NOT
  propertyName. Uri templates come in three dialects (`{id}`, `[IID]`,
  already-concrete) and a `moniker.target` (URL-encoded absolute) beats a
  template. Most uris need `.htmld` appended or they 404. **Never emits
  `sessionSecureToken` or other envelope secrets** — it reads an explicit
  allowlist of fields only.
- `src/redact.ts` — the DUAL of the parser's allowlist: a denylist applied to
  raw envelopes returned by `workday_fetch` / `workday_graphql`, covering secret
  and PII key names — including identity-document collections such as
  `driversLicenses` / `identifications` / `visas` / `customIds` (GraphQL's
  field-keyed JSON has no labels) — plus values
  whose sibling `label` (a string, or a list-card row's `label` column
  widget) or grid column names government/financial PII. Key-name matching is
  only sound because `assertReadOnlyGraphql` refuses aliasing such a field. `getTask` runs it BEFORE `parseTask` too, because
  the allowlist keeps envelope secrets out but copies widget values verbatim.
- `src/client.ts` — deferred config (`WORKDAY_TENANT` required, `WORKDAY_HOST`
  defaulted), the `fetchJson`/`postJson` primitives, path normalization (strips
  `#fragments`, converts copied `/d/` SPA URLs to data endpoints, appends
  `.htmld`), error mapping (non-2xx, SSO/sign-in bounce →
  `SessionNotAuthenticatedError`), and the composed reads: `crawl` (hub → child
  cards, bounded by depth/maxCards/visited), `resolveApp`/`openApp` (by LABEL,
  never a captured id), `getWorker`/`getWorkerTask`/`getOrgChart`,
  `getTeam`/`getReviews`/`getReview`/`getFeedback`, `getRequestForm`,
  `getInbox` (a JSON API that wants the token from `boot-config`'s `appRoot`,
  NOT the envelope token), `getMyRequests`, `getTeamSnapshot`, the request
  reads/writes (`listOpenRequests`/`getRequest`/`planRequestUpdate`/
  `applyRequestUpdate`), and a
  query-only `graphql`. **`getRequestForm` is a non-GET read** (`runReport` is the other): Workday
  only renders a request's form inside the Create Request flow, so it drives
  that flow with form-urlencoded `postForm` steps and ALWAYS cancels it.
  `_eventId_submit` there is the PROMPT page's OK — the same event on a loaded
  form submits it, so it is refused once a page carries the `bpfButtonBar`.
  Never add a step that names a `bpfButton`. **Tenant-specific ids are learned at runtime** — the
  worker-profile uri prefix comes from a live org-chart node, never a constant.
- `src/parse-benefits.ts` — the benefits pages (`parse.ts`' allowlist rule
  applies): your related-task catalog, an enrollment event's window, the
  elections landing page, a plan type's `chunkedEditGrid` of plans on offer,
  a plan's rate table, and elections grids → typed elections. Reads command
  buttons only when they are GETs — the enrollment pages carry POST buttons
  (Save for Later, Review and Sign, Confirm and Continue) that change
  elections. `getBenefits` / `getBenefitEnrollment` in `client.ts` are
  GET-only; `tools/benefits.ts` registers them.
- `src/parse-reports.ts` — report prompt forms (prompts + current values,
  validation errors by prompt) and dashboards (tabs, worklets → `workletIid`,
  GET menu links). `runReport` in `client.ts` is the second non-GET read: it
  drives a prompt report's own flow (remove/search/add, then the prompt's OK)
  and ALWAYS cancels; like `getRequestForm` it refuses any page carrying a
  `bpfButtonBar`. `tools/reports.ts` registers `workday_run_report` and
  `workday_get_dashboard`.
- `src/parse-feedback.ts` — the Give Feedback / Get Feedback forms: commit
  ids, the feedback field, badge options, recipients and template prompts,
  the question list, and the hidden visibility defaults (which the preview
  states); plus changeSummary readers for added question rows.
- `src/transport-fetchproxy.ts` — wraps `@chrischall/mcp-utils/fetchproxy`;
  `splitHost` maps `wd5.myworkday.com` → domain `myworkday.com` + subdomain `wd5`.
- `src/tools/*.ts` — `registerXxxTools(server, client)` → `server.registerTool`.
  `review.ts` is the review-season surface (team, reviews, feedback, request
  forms).
- `src/index.ts` — wires it with `runMcp`; brings the bridge up before stdio.

See `docs/WORKDAY-API.md` for the captured endpoint shapes and the widget schema.

## Conventions

- **TDD.** Failing test → minimal code → green. The parser especially.
- **Verify the parser against real bytes**, not just synthetic fixtures — the
  `propertyName`-vs-object-key bug only showed up against live data.
- Reads only the user's own data. **There are four writes,
  `workday_update_request`, `workday_update_benefit_enrollment`,
  `workday_give_feedback` and `workday_request_feedback`.** The
  first (src/tools/requests.ts): `planRequestUpdate` (fresh read → diff → steps,
  sends nothing) → `confirmWrite` (token bound to request, action, answers,
  preview and a revision hash of the saved answers) → `applyRequestUpdate`
  (posts, stops before the commit on any non-changeSummary, then re-reads to
  verify). The benefits write (src/tools/benefits.ts) has the same shape:
  `planBenefitUpdate` → `confirmWrite` (token also bound to a hash of the
  event's current elections) → `applyBenefitUpdate`, which walks each plan
  type's sub-flow, then Save for Later or Review and Sign → I Accept →
  Submit, stopping at the first step Workday does not acknowledge and naming
  the plan types already changed. The feedback writes (src/tools/feedback.ts):
  `planGiveFeedback` / `planRequestFeedback` drive the real form up to Submit
  (people, badge, template resolved by Workday) and CANCEL it; the token's
  revision is a hash of that preview plus every instance id it resolved; the
  apply re-drives a fresh form, refuses to press Submit if the hash differs,
  requires a changeSummary for every step, and re-reads Feedback Given /
  Requested. Any new write must follow that shape and be added to the explicit
  write allowlist in tests/tool-annotations.test.ts.
- Version lives once in `src/version.ts` (`x-release-please-version`); don't
  hand-bump — release-please owns it. `extra-files` in `release-please-config.json`
  must list every version-bearing manifest.
- Never commit secrets or captured tokens/cookies/values. `.env` is gitignored.

<!-- pr-workflow:v3 -->
## Pull requests & release notes

Fleet policy — Conventional-Commit PR titles, labels, the auto-review /
auto-merge ladder, auto-review follow-up issues, PR timing, and release PRs —
lives in `~/.claude/CLAUDE.md`. Don't restate it here; the copies drifted.

Shared technical conventions (publishing, bundling, versioning guards,
write-verification, transport archetypes, testing traps) live in
[`chrischall/workflows`](https://github.com/chrischall/workflows):
`docs/fleet-conventions.md`, plus `README.md` for the CI pipeline contract.
