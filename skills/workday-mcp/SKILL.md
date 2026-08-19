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
