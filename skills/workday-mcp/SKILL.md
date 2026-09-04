---
name: workday-mcp
description: Read Workday HR data — your org chart and team, worker profiles, pay, benefits, compensation, performance, and any task or data card — via MCP through your own signed-in session. Triggers on phrases like "check my workday", "who reports to X", "my org chart", "look up <person> in workday", "read my workday compensation", "my workday benefits", "<person>'s performance review", "pull this workday page", or any request involving Workday people, pay, benefits, or team data. Read-only. Requires workday-mcp installed and the fetchproxy extension active (see Setup below).
---

# workday-mcp

Read-only MCP server for Workday. Reads your org chart, worker profiles, pay,
benefits, performance, and any task or data card, and returns them as structured
JSON. Every request
routes through your own signed-in `*.myworkday.com` tab via the fetchproxy
browser extension, reusing your existing SSO-authenticated session.

- **npm:** [npmjs.com/package/workday-mcp](https://www.npmjs.com/package/workday-mcp)
- **Source:** [github.com/chrischall/workday-mcp](https://github.com/chrischall/workday-mcp)

> ⚠️ Workday does not give employees a personal API. This server reads the same
> internal `*.htmld` endpoints the Workday web app calls, dispatched through your
> own signed-in browser tab via the fetchproxy extension. It is **read-only** and
> touches only your own data. Check your employer's acceptable-use policy. Use at
> your own discretion.

## Setup

### 1. Install workday-mcp

`.mcp.json` (project) or `~/.claude/mcp.json` (global):

```json
{
  "mcpServers": {
    "workday": {
      "command": "npx",
      "args": ["-y", "workday-mcp"],
      "env": {
        "WORKDAY_TENANT": "your-tenant-slug",
        "WORKDAY_HOST": "wd5.myworkday.com"
      }
    }
  }
}
```

- `WORKDAY_TENANT` (**required**) — the path segment after the host, e.g. for
  `https://wd5.myworkday.com/acme` it is `acme`.
- `WORKDAY_HOST` (optional) — your data-center host; defaults to `wd5.myworkday.com`.
- `WORKDAY_WS_PORT` (optional) — override the fetchproxy port (default 37149).

### 2. Install the fetchproxy extension (one-time, shared across fetchproxy MCPs)

```bash
git clone https://github.com/chrischall/fetchproxy
cd fetchproxy
npm ci
npm --workspace=@fetchproxy/extension-chrome run build
```

Load `fetchproxy/packages/extension-chrome/dist` as an unpacked extension in
`chrome://extensions`. On the first request you'll be asked to approve a pairing
code in the extension popup (one-time, per server identity).

### 3. Sign into Workday

Open `https://<host>/<tenant>` in your browser and complete SSO. workday-mcp
reuses that live session — there is no separate login.

## Tools

### People — the manager surface

- **`workday_get_org_chart`** — your reporting chain: each person with business
  title, location, report count, and a `profileUri` ready for
  `workday_get_worker`. Resolves the Org Chart app from your own app menu.
- **`workday_get_worker`** — a worker's profile, returned as the **catalog** of
  everything readable about them: sections (Job, Compensation, Benefits, Contact,
  Personal, Performance, Career, Feedback) each listing named, fetchable tasks —
  roughly 40 of them. Takes a `profileUri` or a bare worker id like `247$42`.
- **`workday_get_worker_task`** — open ONE item from that catalog by name:
  `Compensation`, `Job Details`, `Management Chain`, `Performance Reviews`,
  `Pay Change History`, `Benefits`, `Goals`, `Associate History`… Matched
  case-insensitively; a miss lists exactly what is available.
- **`workday_get_my_profile`** — the same catalog, for yourself.

### Navigation

- **`workday_get_apps`** — list your Workday apps, each with a task id.
- **`workday_open_app`** — open an app **by name** ("Talent and Performance",
  "My Team Management", "Absence", "Total Rewards") and crawl it down to the
  child cards that hold its content. Most Workday hubs return a near-empty
  shell on their own; this follows the links. Use `depth` / `maxCards` to bound
  it — every hop is a real fetch through your browser.
- **`workday_get_task`** — read any task or data card by bare task id, a prior
  result's `references[].uri`, or a pasted Workday URL (`/d/` SPA URLs are
  normalized). Pass `expand: true` to crawl a hub page instead of getting its
  shell.

### Escape hatches

- **`workday_fetch`** — raw `.htmld` read, secrets redacted, for pages the
  parser doesn't model yet. Use when a typed tool returns less than the page
  clearly shows.
- **`workday_graphql`** — read-only GraphQL against Workday's PEX surface.
  `mutation` / `subscription` documents are refused. This is the only route to
  the Inbox / "My Tasks" and global search, but Workday doesn't publish the
  operations — you supply the document, and should expect to iterate.

### Diagnostics

- **`workday_healthcheck`** — verify the bridge + session end-to-end, with a
  hint distinguishing "bridge down" from "extension not connected" from
  "Workday session expired (re-sign-in)".

## Response shape (`view`)

Three of this server's ten tools take `view: "compact" | "full"` —
**`workday_get_task`**, **`workday_open_app`** and
**`workday_get_worker_task`** — and on all three **`compact` is the DEFAULT**.
The slim rung is what you get without asking for it.

Those three are the deep reads: the ones that follow a hub down to its child
cards, or open one named item on a profile, and can therefore come back with a
lot of page in them.

**Compact here is media stripping, not a field projection.** `src/view.ts`
writes no field list, and says why: this repo holds no captured Workday
payload and no documented field list, so nothing in it could honestly claim
which of Workday's fields matter. What it does instead is subtractive — remove
keys whose value is a picture (`avatar`, `photo`, `icon`, `image`, `logo`,
`banner`, and their `Url` / `Uri` / `Link` forms) plus bare image URLs — which
cannot lose a field nobody knew about. **No field is named as kept**, because
no tool here has a picture as its product.

**Expect compact to remove very little, and know why.** The parser has already
done most of this job: `DECORATIVE_COLUMNS` drops `uxIcon`, `image`, `icon`,
`avatar`, `photo` and `indicatorIcon` from a grid row's cells AND from its
references, before anything reaches `view` — deliberately, so a decorative
column never reads as data. So on a `grid` page compact often has nothing left
to take. Do not read a slim `card` or `grid` response as evidence that content
was withheld; if a field is missing it is far more likely the page did not
carry it.

`view: "full"` returns the parsed page untouched. There is deliberately **no
`raw` rung**: `full` already IS the structure this server parsed out of
Workday's `.htmld` response, and for the genuinely unparsed article there is a
tool — `workday_fetch`, below. A third `view` value would silently alias one
that exists.

### Why the other seven have none

- **`workday_get_org_chart`** answers with an ASSEMBLED record —
  `{workerId, managementChain, atThisLevel, note}` — built from the org-chart
  page rather than handed through from it. There is no upstream payload to
  slim, and the `note` explaining a chain-upward-only result is exactly the
  kind of field a blind projection must not touch.
- **`workday_get_worker` and `workday_get_my_profile`** answer with a
  CATALOG: the sections of a profile and the ~40 named tasks that are
  fetchable on it. A list of task names has no picture in it, and the names
  are the whole product — you pass one straight back into
  `workday_get_worker_task`, which is where the rung lives.
- **`workday_get_apps`** answers with app names and their launchable task ids.
  Same shape of answer, same reason.
- **`workday_fetch`** is the escape hatch: it exists to hand back the RAW
  `.htmld` response, secrets redacted, for a page the parser does not model
  yet. Projecting the escape hatch would defeat the reason to reach for it —
  you call it precisely to see fields the typed tools drop. Its size control
  is `maxBytes`, which truncates honestly, not a rung that removes by
  category.
- **`workday_graphql`** is the other escape hatch, and you supply the document
  — so you have already chosen the fields, and `maxBytes` bounds the result.
- **`workday_healthcheck`** answers with a diagnostic verdict: which hop is
  broken, and what to do about it. Nothing in it is decoration.

Passing `view` to one of those is not an error and will not fail: the tool
does not declare it, so zod drops the unknown key and the call runs exactly as
it would have. Nothing warns you, so a successful call is not evidence the
rung was honoured.

## What the parser understands

Each page comes back labelled with a `kind`, because Workday serves seven
different page families and only some carry data:

| `kind` | What it is | What to read |
| --- | --- | --- |
| `card` | A data card | `sections[].fields`, `sections[].rows` |
| `grid` | A real table | `grids[]` — columns, rows, `totalRowCount`, `excel` |
| `form` | A detail page | `sections[].fields` |
| `profile` | A worker profile | `profile.sections[].tasks` |
| `orgchart` | An org chart | `org.ancestors`, `org.nodes` |
| `hub` | An app hub | `navigation[]` |
| `prompt` | A report **parameter form** | `prompts[]` — it needs inputs, so a GET returns no data |

**A chunked grid is not the whole table.** When `totalRowCount` exceeds the rows
returned, Workday sent only the first page — say so rather than reporting a
partial team as complete.

## How navigation works

Everything is discovered at runtime; nothing tenant-specific is hardcoded.

1. `workday_get_org_chart` or `workday_get_apps` to get your bearings.
2. Follow a `profileUri` into `workday_get_worker` for a person, or an app name
   into `workday_open_app` for a hub.
3. Use `workday_get_worker_task` to open a named item on a profile.

If a page comes back near-empty, it is usually a hub (retry with
`workday_open_app` / `expand: true`) or a prompt form (`kind: 'prompt'` — it
wants parameters and cannot be read with a GET). Some apps share a generic
launcher id and open to a shell; for those, open the page in your browser and
paste its URL into `workday_get_task`.

## Status

**Read-only.** Known gaps, all documented in `docs/WORKDAY-API.md`:

- **Direct reports** — the org chart returns the chain UPWARD; expanding down to
  reports is a POST-only navigation in Workday, so it is not available over a
  GET. Read a person's profile and use their `Organizations` / `Management
  Chain` tasks instead.
- **Inbox / "My Tasks" and global search** — no GET-able endpoint; served by
  GraphQL, reachable through `workday_graphql` once you have the operation.
- **Prompted reports** — need a POST of parameter values.
- **Writes** — not implemented; they are multi-step business processes and would
  need a `confirm` gate, a dry-run preview, and re-read verification.
