# workday-mcp

Read-only MCP server for [Workday](https://www.workday.com/). Reads your
Workday org chart, worker profiles, pay, benefits, performance, and any task or
data card, and returns them as structured JSON. Every request routes through your own signed-in
`*.myworkday.com` tab via the [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge)
browser extension, reusing your existing SSO-authenticated session.

> ⚠️ Workday gives employees no personal API. This server reads the same internal
> `*.htmld` endpoints the Workday web app calls, dispatched through your own
> signed-in browser tab. It is **read-only** and touches only your own data.
> Check your employer's acceptable-use policy. Use at your own discretion.
>
> 🤖 This project was developed and is maintained by AI (Claude Code).

## Why a bridge instead of the official API?

The official Workday REST/SOAP API requires a tenant administrator to register
an OAuth API client + Integration System User — an employee can't self-provision
it. Tenants also sit behind corporate SSO (Ping/Okta/Entra) with MFA, so there's
no server-side login. The only surface an employee can reach for their own data
is their **live browser session**, which is what this server relays.

## Install

See [SKILL.md](./skills/workday-mcp/SKILL.md) for full setup. In brief:

```json
{
  "mcpServers": {
    "workday": {
      "command": "npx",
      "args": ["-y", "workday-mcp"],
      "env": { "WORKDAY_TENANT": "your-tenant-slug" }
    }
  }
}
```

Then install ContextMint Bridge from its
[releases page](https://github.com/nullnet-app/contextmint-bridge/releases)
(Chrome: unzip the chrome zip and load it unpacked in `chrome://extensions`;
Safari is not available yet — it will ship inside the ContextMint app, which has
no public download link, so use Chrome for now) and sign into Workday in your browser.

ContextMint Bridge is the fetchproxy browser extension under its new name, from
the same maintainer — fetchproxy's own
[README](https://github.com/chrischall/fetchproxy#extension) points to it. Its
source is public at <https://github.com/nullnet-app/contextmint-bridge>: build it
yourself, or check a release zip against the `.sha256` file published beside it
(`shasum -a 256 -c contextmint-bridge-chrome-<version>.zip.sha256`).

## Tools

| Tool | What it does |
| --- | --- |
| `workday_get_apps` | List your Workday apps with launchable task ids — the discovery entry point |
| `workday_open_app` | Open an app **by name** ("Talent and Performance", "Absence") and follow it down to the child cards holding its real content |
| `workday_get_task` | Read any task/data card by id or path → fields, full table rows, references, related tasks, export links. `expand: true` crawls hub pages |
| `workday_get_org_chart` | Your reporting chain — each person with title, location, report count, and a `profileUri` to drill into |
| `workday_get_worker` | A worker's profile: the **catalog** of everything readable about them (9 sections, ~40 named tasks) |
| `workday_get_worker_task` | Open one named item from that catalog — "Compensation", "Performance Reviews", "Management Chain" |
| `workday_get_my_profile` | The same catalog, for yourself |
| `workday_get_team` | The people on the teams you manage — each with worker id, position, location and profile link |
| `workday_get_reviews` | A worker's performance reviews (period, rating), or one review in full: manager and employee ratings and comments, goals, development items |
| `workday_get_feedback` | Feedback a worker received, gave, or requested — author, date, badge and full text |
| `workday_get_inbox` | Your inbox ("My Tasks"): review comments to provide, feedback requests, questionnaires, approvals — each with a `uri` to open read-only. `category: "archive"` for completed items |
| `workday_get_my_requests` | The requests you created (e.g. promotion consideration forms) with their status |
| `workday_get_request_form` | A request type's form (e.g. a promotion consideration form): instructions plus every question, required flag, answer type and options. Opens a new request to read it and cancels it before returning, so nothing is created |
| `workday_fetch` | Raw `.htmld` read with secrets redacted — the escape hatch for pages the parser doesn't model yet |
| `workday_graphql` | Read-only GraphQL against Workday's PEX surface (mutations refused). The only route to Inbox / search |
| `workday_healthcheck` | Verify the bridge + session end-to-end with an actionable hint |

The parser understands seven Workday page families — data cards, **grids**
(real tables, with chunking and export links), form-style detail pages, worker
profiles, org charts, app hubs, and report prompt forms — and labels each page
with its `kind`. See [docs/WORKDAY-API.md](./docs/WORKDAY-API.md).

### Manager quick start

```
workday_get_org_chart                                   → who reports where, with profileUris
workday_get_worker         { worker: "<profileUri>" }   → that person's full catalog
workday_get_worker_task    { worker: "…", task: "Compensation" }
workday_open_app           { app: "talent" }            → a whole app hub, crawled
```

### Review and promotion season

```
workday_get_team                                        → your reports, with workerIds
workday_get_reviews        { worker: "247$42" }         → their review history
workday_get_reviews        { worker: "247$42", review: "latest" }   → ratings + comments
workday_get_feedback       { worker: "247$42" }         → feedback received
workday_get_request_form   { requestType: "promotion consideration" } → the form's questions
workday_get_inbox                                       → review steps and requests waiting on you
workday_get_my_requests                                 → status of what you submitted
```

All ids are discovered at runtime from your own app menu and org chart — nothing
tenant-specific is hardcoded, so this works on any Workday tenant.

## Development

```bash
npm install
npm test          # vitest
npm run build     # tsc --noEmit + esbuild bundle → dist/bundle.js
```

The widget-tree parser (`src/parse.ts`) is the durable core; see
[docs/WORKDAY-API.md](./docs/WORKDAY-API.md) for the captured endpoint shapes and
schema. License: MIT.
