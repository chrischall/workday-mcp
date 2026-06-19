# workday-mcp

Read-only MCP server for [Workday](https://www.workday.com/). Fetches your
Workday tasks and data cards — pay, benefits, compensation — and returns them as
structured JSON. Every request routes through your own signed-in
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

See [SKILL.md](./SKILL.md) for full setup. In brief:

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
| `workday_get_task` | Read a Workday task/data card by task id or path → title, fields, references, related tasks, export links |
| `workday_healthcheck` | Verify the bridge + session end-to-end with an actionable hint |

## Development

```bash
npm install
npm test          # vitest
npm run build     # tsc --noEmit + esbuild bundle → dist/bundle.js
```

The widget-tree parser (`src/parse.ts`) is the durable core; see
[docs/WORKDAY-API.md](./docs/WORKDAY-API.md) for the captured endpoint shapes and
schema. License: MIT.
