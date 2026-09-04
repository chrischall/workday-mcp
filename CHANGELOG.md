# Changelog

## [0.6.0](https://github.com/chrischall/workday-mcp/compare/v0.5.0...v0.6.0) (2026-09-04)


### Features

* **tools:** compact by default — strip media URLs, and minify every response ([#79](https://github.com/chrischall/workday-mcp/issues/79)) ([06b3217](https://github.com/chrischall/workday-mcp/commit/06b3217a3f78b4eaabc419efdcb6346903dc640d))


### Bug Fixes

* **build:** restore the literal em dash in the package description ([#81](https://github.com/chrischall/workday-mcp/issues/81)) ([c861cbb](https://github.com/chrischall/workday-mcp/commit/c861cbb35e75751c9768d0ee9414cfdfe0fab009))
* **deps:** pick up @chrischall/mcp-utils 0.23.1 ([#82](https://github.com/chrischall/workday-mcp/issues/82)) ([5184fd4](https://github.com/chrischall/workday-mcp/commit/5184fd4f54ea07f646fd26911d43bce411785333))
* **deps:** pick up @chrischall/mcp-utils 0.23.2 ([#84](https://github.com/chrischall/workday-mcp/issues/84)) ([1dce9b2](https://github.com/chrischall/workday-mcp/commit/1dce9b20385f9c1e627142391fceb6cd0d8ce658))
* **mcp:** drop the dead minifiedResult import and correct its docblock ([#85](https://github.com/chrischall/workday-mcp/issues/85)) ([126f849](https://github.com/chrischall/workday-mcp/commit/126f849892e4b9285544b14ffa640d53db62f294))


### Documentation

* **mint:** declare WORKDAY_DEBUG in mint.yaml ([#69](https://github.com/chrischall/workday-mcp/issues/69)) ([cc77f5b](https://github.com/chrischall/workday-mcp/commit/cc77f5b0c181bacee735b04a2419c101c38c8195))

## [0.5.0](https://github.com/chrischall/workday-mcp/compare/v0.4.1...v0.5.0) (2026-08-29)


### Features

* **deps:** take @fetchproxy/server 2.2.0 so the concentrator can bind its sandbox address ([#62](https://github.com/chrischall/workday-mcp/issues/62)) ([09bd97a](https://github.com/chrischall/workday-mcp/commit/09bd97ae8a17f0260c16bee09b9df1573c31d2e9))

## [0.4.1](https://github.com/chrischall/workday-mcp/compare/v0.4.0...v0.4.1) (2026-08-28)


### Bug Fixes

* **egress:** declare every host the server dials in mint.yaml ([#60](https://github.com/chrischall/workday-mcp/issues/60)) ([5e74aa0](https://github.com/chrischall/workday-mcp/commit/5e74aa0858f300b1eaf3f2b1d9ca17205fef287e))

## [0.4.0](https://github.com/chrischall/workday-mcp/compare/v0.3.2...v0.4.0) (2026-08-19)


### Features

* add org chart, worker profile, and app-hub reads to the read-only API ([#45](https://github.com/chrischall/workday-mcp/issues/45)) ([a7e5cc1](https://github.com/chrischall/workday-mcp/commit/a7e5cc16ad3dfe51434f8cc1c75e71985d55d33b))


### Bug Fixes

* refuse GraphQL documents whose definition boundaries cannot be tracked ([#48](https://github.com/chrischall/workday-mcp/issues/48)) ([06453f5](https://github.com/chrischall/workday-mcp/commit/06453f550eb1a80491ee29db8b48b5f2b1a6ec6f))


### Documentation

* correct the stale SDL claim in the read-only guard comment ([#50](https://github.com/chrischall/workday-mcp/issues/50)) ([9759c24](https://github.com/chrischall/workday-mcp/commit/9759c24a8a89b1212a7c379a937843fd5163f69e)), closes [#49](https://github.com/chrischall/workday-mcp/issues/49)

## [0.3.2](https://github.com/chrischall/workday-mcp/compare/v0.3.1...v0.3.2) (2026-08-06)


### Bug Fixes

* **deps:** move to @fetchproxy/server 2.0.0 for the v3 handshake ([#39](https://github.com/chrischall/workday-mcp/issues/39)) ([44eb133](https://github.com/chrischall/workday-mcp/commit/44eb133a7beb1ddaceaa70e8b8c93c022b7d699f))

## [0.3.1](https://github.com/chrischall/workday-mcp/compare/v0.3.0...v0.3.1) (2026-07-30)


### Bug Fixes

* **deps:** bump @fetchproxy/* to 1.7.0 and @chrischall/mcp-utils to 0.14.0 ([#31](https://github.com/chrischall/workday-mcp/issues/31)) ([0161fd2](https://github.com/chrischall/workday-mcp/commit/0161fd2fbcc8d48ada76735ebb5b15d9ac004e3b))

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
