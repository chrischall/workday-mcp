# Workday `*.htmld` endpoints for fpx

Ready-to-run paths for `fpx get '<url>' -p workday`. All shapes are
live-verified in the repo (`src/client.ts`, `src/tools/*.ts`,
`docs/WORKDAY-API.md`) against a production tenant on `wd5.myworkday.com`
(2026-06). Replace `wd5.myworkday.com`/`acme` with your own
`$HOST`/`$TENANT`.

Every response is a `root` envelope: page chrome (`title`, `taskId`,
`tenant`, `currentUser`, `accountTasks`, `header` export links,
**`sessionSecureToken` — SECRET, never project this**) plus a `body.
cardContentSections[]` tree of `text` / `moniker` / `monikerList` leaf
widgets. **Always pipe through one of the filters below — never bare
`jq '.'`.**

---

## 1. List your apps (the discovery entry point)

```
GET https://$HOST/$TENANT/quickaccess/fetch.htmld?shouldFetchUpcApps=true
```

```sh
fpx get "https://$HOST/$TENANT/quickaccess/fetch.htmld?shouldFetchUpcApps=true" -p workday \
  | jq '[.. | objects | select(.widget=="configuredAppsItem") | {label, taskId: .taskIid}] | unique_by(.label)'
```

A `widget/children` tree; leaf `configuredAppsItem` nodes carry `label` +
`taskIid`. Some apps share a generic launcher id (e.g. `2997$2151`) and open
to a near-empty page — for those, open the app in your browser and use its
page URL with endpoint 3 instead.

## 2. Task by id (constructable — no page-context token needed)

```
GET https://$HOST/$TENANT/task/<taskId>.htmld
```

`<taskId>` looks like `2998$43525` (from endpoint 1, or a prior response's
references). Returns clean JSON for any task id, but **container/launcher
tasks return a near-empty shell** (no `cardContentSections`) — rich data
needs endpoints 3+4 below.

```sh
fpx get "https://$HOST/$TENANT/task/2998\$43525.htmld" -p workday | jq '{
  title: (if (.title|type)=="object" then .title.text else .title end),
  fields: [.. | objects | select(.widget=="text") | {label, value}],
  refs:   [.. | objects | select(.widget=="moniker") | {text, instanceId}],
  relatedTasks: (.accountTasks // [])
}'
```

(Escape the literal `$` in a task id before the shell expands it, as shown.)

## 3. Task hub → data card crawl (rich data)

Container tasks (Benefits and Pay, etc.) delegate to child cards through two
opaque, page-context-bound tokens you can only get by loading the parent:

```
GET https://$HOST/$TENANT/inst/<pageCtx>/cacheable-task/<taskId>.htmld   # the hub
GET https://$HOST/$TENANT/card/all/<cardId>/<pageCtx>.htmld              # a child card (the real content)
```

`<pageCtx>` is NOT constructable — read it off the hub response's own
references/uris (or copy the child card's URL from your open browser tab).
The `cacheable-task` token is comparatively stable across loads; the
`card/all` child token rotates. Project the hub response the same way as
endpoint 2; the child card usually contains list-card rows (see below).

## 4. List-card rows (e.g. a benefits cost table)

A list/table section's `contentSectionItems[]` are ROW objects keyed by
clean column names (`label`, `value`, `secondaryValue`, `task`,
`onInstance`, …) rather than a flat `text` widget — key on the **column
name**, not `propertyName` (Workday's real propertyNames are namespaced,
`wd:Label`/`nyw:Value`, and are template noise here). Approximate the
row read with:

```sh
fpx get "https://$HOST/$TENANT/card/all/<cardId>/<pageCtx>.htmld" -p workday | jq '
  .body.cardContentSections[]? | {
    section: .contentSectionName,
    rows: [.contentSectionItems[]? | {
      label: (.label.value // .label.label // empty),
      value: ([.value.value, .secondaryValue.value] | map(select(. != null)) | join(" ")),
    }]
  }'
```

Drill-in references for a row come from its navigational columns only
(`task`, `onInstance`, `relatedTaskInstance`, `quicklinkItem` — `uxIcon`/
`image` monikerLists are decoration):

```sh
fpx get "https://$HOST/$TENANT/card/all/<cardId>/<pageCtx>.htmld" -p workday | jq '
  [.body.cardContentSections[]?.contentSectionItems[]?
   | (.task, .onInstance, .relatedTaskInstance, .quicklinkItem)?
   | select(. != null)
   | .. | objects | select(.widget=="moniker") | {text, instanceId}]'
```

## 5. Healthcheck probe (tiny authenticated endpoint)

```
GET https://$HOST/$TENANT/get-global-prefs.htmld?feature=doNotShowMobileAd
```

```sh
fpx get "https://$HOST/$TENANT/get-global-prefs.htmld?feature=doNotShowMobileAd" -p workday | jq -r '
  if (type=="object") then "ok (\(. | length) top-level keys)" else "unexpected body" end'
```

Cheap way to confirm the bridge + tab + SSO session are all alive before a
bigger crawl — a non-JSON/HTML result here means the session expired (see
SKILL.md's session-expiry tell).

---

## SPA URL → data endpoint

If you copy a URL from your open Workday tab and it contains `/d/`
(`https://$HOST/$TENANT/d/inst/....htmld`), drop the `/d/` segment before
fetching — that path is the HTML app shell, not data:

```sh
url="https://wd5.myworkday.com/acme/d/inst/13102!ABC/cacheable-task/2998\$43525.htmld"
data_url="${url/\/d\///}"   # → .../acme/inst/13102!ABC/cacheable-task/2998$43525.htmld
fpx get "$data_url" -p workday | jq '...'
```

## Omitted (undiscoverable from the repo)

- **GraphQL surface** (`/wday/pex/graphql/graphql?operation=...`, POST) —
  serves the inbox/"My Tasks" and global search, per `docs/WORKDAY-API.md`'s
  Follow-ons. No captured operation/persisted-query shape exists yet in the
  repo, so it's left out here rather than guessed.
- **Writes** — none exist in workday-mcp v1 (read-only); Workday writes are
  multi-step business processes, not single POSTs.
