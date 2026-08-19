# workday-mcp

Read-only MCP server for [Workday](https://www.workday.com/). Reads your
Workday org chart, worker profiles, pay, benefits, performance, and any task or
data card, and returns them as structured JSON. Every request routes through your own signed-in
`*.myworkday.com` tab via the [fetchproxy](https://github.com/chrischall/fetchproxy)
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

Then install the fetchproxy extension and sign into Workday in your browser.

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
