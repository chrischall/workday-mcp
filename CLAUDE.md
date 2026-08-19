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
  key names plus values whose sibling `label` names government/financial PII.
- `src/client.ts` — deferred config (`WORKDAY_TENANT` required, `WORKDAY_HOST`
  defaulted), the `fetchJson`/`postJson` primitives, path normalization (strips
  `#fragments`, converts copied `/d/` SPA URLs to data endpoints, appends
  `.htmld`), error mapping (non-2xx, SSO/sign-in bounce →
  `SessionNotAuthenticatedError`), and the composed reads: `crawl` (hub → child
  cards, bounded by depth/maxCards/visited), `resolveApp`/`openApp` (by LABEL,
  never a captured id), `getWorker`/`getWorkerTask`/`getOrgChart`, and a
  query-only `graphql`. **Tenant-specific ids are learned at runtime** — the
  worker-profile uri prefix comes from a live org-chart node, never a constant.
- `src/transport-fetchproxy.ts` — wraps `@chrischall/mcp-utils/fetchproxy`;
  `splitHost` maps `wd5.myworkday.com` → domain `myworkday.com` + subdomain `wd5`.
- `src/tools/*.ts` — `registerXxxTools(server, client)` → `server.registerTool`.
- `src/index.ts` — wires it with `runMcp`; brings the bridge up before stdio.

See `docs/WORKDAY-API.md` for the captured endpoint shapes and the widget schema.

## Conventions

- **TDD.** Failing test → minimal code → green. The parser especially.
- **Verify the parser against real bytes**, not just synthetic fixtures — the
  `propertyName`-vs-object-key bug only showed up against live data.
- Reads only the user's own data. Read-only in v1; future writes must be
  `confirm`-gated with a dry-run `preview()` + re-read verification.
- Version lives once in `src/version.ts` (`x-release-please-version`); don't
  hand-bump — release-please owns it. `extra-files` in `release-please-config.json`
  must list every version-bearing manifest.
- Never commit secrets or captured tokens/cookies/values. `.env` is gitignored.
- Don't merge PRs or add `ready-to-merge` yourself; `pr-auto-review` +
  `auto-merge` ship it.

## Pull requests & release notes

Apply exactly one release-notes label per PR (`enhancement` → Features, `bug` → Bug Fixes, `dependencies` → Dependencies, etc.), and give the PR a Conventional-Commit title — release-please parses the squash subject to pick the version bump and changelog section.

**Exception for first-party dependency bumps.** When bumping a package we own (`@chrischall/mcp-utils`, `@chrischall/realty-core`, `@fetchproxy/server` — anything published from a chrischall-owned repo), label the PR `enhancement` or `bug` instead of `dependencies`, and use the matching Conventional-Commit prefix (`feat:` or `fix:`) instead of `chore:`/`build(deps):`. Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden under "Dependencies" (which doesn't trigger a release).
