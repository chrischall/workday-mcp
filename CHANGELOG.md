# Changelog

## [0.3.0](https://github.com/chrischall/workday-mcp/compare/v0.2.1...v0.3.0) (2026-07-13)


### Features

* **skill:** add workday fpx access skill ([#18](https://github.com/chrischall/workday-mcp/issues/18)) ([fdaf250](https://github.com/chrischall/workday-mcp/commit/fdaf250a7393b7b0d33da2528adc274837a32cec))


### Bug Fixes

* **skill:** restrict list-card drill-in jq to navigational columns ([#22](https://github.com/chrischall/workday-mcp/issues/22)) ([5ee48fa](https://github.com/chrischall/workday-mcp/commit/5ee48fa5528a0912107783676fafb16b405734d9)), closes [#19](https://github.com/chrischall/workday-mcp/issues/19)


### Refactor

* **skill:** move root SKILL.md into skills/, point plugin.json at ./skills/ ([#21](https://github.com/chrischall/workday-mcp/issues/21)) ([e748d3d](https://github.com/chrischall/workday-mcp/commit/e748d3db4cbcd0393e178ad3f509d88f91480050))

## [0.2.1](https://github.com/chrischall/workday-mcp/compare/v0.2.0...v0.2.1) (2026-07-07)


### Bug Fixes

* bump @chrischall/mcp-utils to 0.12.0 ([#13](https://github.com/chrischall/workday-mcp/issues/13)) ([bd423a8](https://github.com/chrischall/workday-mcp/commit/bd423a8835483d3b2a8a05765104b3e0bf628bfd))


### Refactor

* adopt registerBridgeHealthcheckTool hooks + shared error/util helpers ([#9](https://github.com/chrischall/workday-mcp/issues/9)) ([5703896](https://github.com/chrischall/workday-mcp/commit/5703896c5cd361aae3217097d89de62d3d250cde))


### Documentation

* document first-party dependency-bump label exception ([#14](https://github.com/chrischall/workday-mcp/issues/14)) ([bd48620](https://github.com/chrischall/workday-mcp/commit/bd486203deb23618b348a37447b0090718eb9c0c))

## [0.2.0](https://github.com/chrischall/workday-mcp/compare/v0.1.0...v0.2.0) (2026-06-19)


### Features

* add workday_get_apps discovery + generalize the parser ([#3](https://github.com/chrischall/workday-mcp/issues/3)) ([105c0d3](https://github.com/chrischall/workday-mcp/commit/105c0d3cfafee4b51f86e60bfbe7e3604d20fd0c))
* read-only Workday MCP via fetchproxy ([e2c4bd6](https://github.com/chrischall/workday-mcp/commit/e2c4bd6a573d6d8e4e095c39625d9511f7d93126))


### Bug Fixes

* align parseApps taskId guard to truthiness ([#5](https://github.com/chrischall/workday-mcp/issues/5)) ([431000c](https://github.com/chrischall/workday-mcp/commit/431000c943fc40f087e99a166fcd634f73996525)), closes [#4](https://github.com/chrischall/workday-mcp/issues/4)
