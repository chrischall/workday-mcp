# Changelog

## [1.1.8](https://github.com/chrischall/workday-mcp/compare/v1.1.7...v1.1.8) (2026-10-09)


### Bug Fixes

* annotate tools truthfully and sync manifests with the served tools ([#155](https://github.com/chrischall/workday-mcp/issues/155)) ([f7892f6](https://github.com/chrischall/workday-mcp/commit/f7892f67430231d138b8a98f68c0734f5cf806d2))
* declare the plugin MCP config under the mcpServers key Claude Code reads ([#156](https://github.com/chrischall/workday-mcp/issues/156)) ([e231903](https://github.com/chrischall/workday-mcp/commit/e2319035ffa6da856d8aab75f51f9e2c8187fa73))
* **deps:** Bump @modelcontextprotocol/server ([#152](https://github.com/chrischall/workday-mcp/issues/152)) ([2532c24](https://github.com/chrischall/workday-mcp/commit/2532c247f8dc4df2b9c67720e10b08a3650bfecc))
* **deps:** update @chrischall/mcp-utils to 3.0.0 ([#154](https://github.com/chrischall/workday-mcp/issues/154)) ([2aa6459](https://github.com/chrischall/workday-mcp/commit/2aa64593bb8c2ba1deaf0a6c4cb2e11682884a85))
* resolve low-severity audit findings ([#148](https://github.com/chrischall/workday-mcp/issues/148)) ([dde6ec5](https://github.com/chrischall/workday-mcp/commit/dde6ec5746560e57d30b293f674ec5bdd12649e6))
* **security:** mark third-party Workday text as untrusted in read results ([#153](https://github.com/chrischall/workday-mcp/issues/153)) ([b3b1bf7](https://github.com/chrischall/workday-mcp/commit/b3b1bf79f9cce72a842692c49feaf8afbdc4ffc8))

## [1.1.7](https://github.com/chrischall/workday-mcp/compare/v1.1.6...v1.1.7) (2026-10-07)


### Bug Fixes

* **deps:** pick up mcp-utils 2.15.0 elicitation opt-out and fetchproxy 3.6.0 relay frame fixes ([#146](https://github.com/chrischall/workday-mcp/issues/146)) ([326d8f5](https://github.com/chrischall/workday-mcp/commit/326d8f58aa1c3b6b4bb5377474d7db2c1ed07307))

## [1.1.6](https://github.com/chrischall/workday-mcp/compare/v1.1.5...v1.1.6) (2026-10-05)


### Bug Fixes

* **deps:** require @chrischall/mcp-utils 2.14.0 and MCP SDK 2.3.0 ([#144](https://github.com/chrischall/workday-mcp/issues/144)) ([d011280](https://github.com/chrischall/workday-mcp/commit/d011280397465e8f7c22f834fa98307977be0fa6))

## [1.1.5](https://github.com/chrischall/workday-mcp/compare/v1.1.4...v1.1.5) (2026-10-03)


### Bug Fixes

* **deps:** bump @chrischall/mcp-utils to 2.12.0 ([#141](https://github.com/chrischall/workday-mcp/issues/141)) ([9757a79](https://github.com/chrischall/workday-mcp/commit/9757a797219b016f5a54575c13e1f062953558b8))
* **deps:** bump @chrischall/mcp-utils to 2.13.0 ([#143](https://github.com/chrischall/workday-mcp/issues/143)) ([3cd6fe7](https://github.com/chrischall/workday-mcp/commit/3cd6fe737b10632287fe648d41f1c4248cd6f476))
* **deps:** Bump the production-dependencies group with 2 updates ([#137](https://github.com/chrischall/workday-mcp/issues/137)) ([f540d8c](https://github.com/chrischall/workday-mcp/commit/f540d8ca98d40fd85c6737e7c0642c2bdbfb2af8))
* keep credentials and report edge_blocked on CDN/WAF blocks (mcp-utils 2.10.0) ([#140](https://github.com/chrischall/workday-mcp/issues/140)) ([3682f06](https://github.com/chrischall/workday-mcp/commit/3682f06dc6d3c69bd48a3f57f53da08c6fde0723))
* report CDN/WAF blocks as edge_blocked, not a rejected credential (mcp-utils 2.9.0) ([#139](https://github.com/chrischall/workday-mcp/issues/139)) ([6cb4792](https://github.com/chrischall/workday-mcp/commit/6cb47923e6d71f84275e8e474d7ca4ddc3a8df78))


### Documentation

* replace restated PR policy with the fleet-policy pointer ([#142](https://github.com/chrischall/workday-mcp/issues/142)) ([838138f](https://github.com/chrischall/workday-mcp/commit/838138f645cd6215530fa2c02d96efd4439c8697))

## [1.1.4](https://github.com/chrischall/workday-mcp/compare/v1.1.3...v1.1.4) (2026-09-27)


### Bug Fixes

* **deps:** move to [@fetchproxy](https://github.com/fetchproxy) 3.4 for ContextMint Bridge errors, capability subsets and managed pins ([#128](https://github.com/chrischall/workday-mcp/issues/128)) ([862d98a](https://github.com/chrischall/workday-mcp/commit/862d98ade3a62868749530d90b63d4ff1b6b3948))
* **deps:** move to @chrischall/mcp-utils 2.8 and [@fetchproxy](https://github.com/fetchproxy) 3.4.1 for clearer browser-bridge errors ([#133](https://github.com/chrischall/workday-mcp/issues/133)) ([e21399c](https://github.com/chrischall/workday-mcp/commit/e21399c6bdde3047610e6c20ee4f45ed87da2dca))
* **install:** state ContextMint Bridge provenance and checksum verification beside every install step ([#131](https://github.com/chrischall/workday-mcp/issues/131)) ([53cddcd](https://github.com/chrischall/workday-mcp/commit/53cddcdc963f8cb3c0f86376c373850991962295))


### Documentation

* **skills:** note in the workday-fpx skill that the Safari ContextMint app has no public download link ([#134](https://github.com/chrischall/workday-mcp/issues/134)) ([edc8cd9](https://github.com/chrischall/workday-mcp/commit/edc8cd931e3acfd08036bce549f735d0593d44e6))

## [1.1.3](https://github.com/chrischall/workday-mcp/compare/v1.1.2...v1.1.3) (2026-09-24)


### Bug Fixes

* **redact:** withhold driver's licence, visa and other identity-document numbers from raw reads ([#125](https://github.com/chrischall/workday-mcp/issues/125)) ([d4182d8](https://github.com/chrischall/workday-mcp/commit/d4182d8b966257adabc93e74c50055f35349dda2))

## [1.1.2](https://github.com/chrischall/workday-mcp/compare/v1.1.1...v1.1.2) (2026-09-23)


### Bug Fixes

* **security:** redact government and financial PII from typed and raw Workday reads ([#119](https://github.com/chrischall/workday-mcp/issues/119)) ([59921ed](https://github.com/chrischall/workday-mcp/commit/59921ed1d9fcbb141619d940a77c19909010f823))

## [1.1.1](https://github.com/chrischall/workday-mcp/compare/v1.1.0...v1.1.1) (2026-09-23)


### Bug Fixes

* **deps:** require zod ^4.6.5 to match @chrischall/mcp-utils 2.4.0 ([#117](https://github.com/chrischall/workday-mcp/issues/117)) ([0100681](https://github.com/chrischall/workday-mcp/commit/0100681894172e9755bf339464a53c3072c71432))
* **deps:** upgrade @chrischall/mcp-utils to 2.4.0 and @fetchproxy/* to 3.2.0 ([#115](https://github.com/chrischall/workday-mcp/issues/115)) ([48ccc80](https://github.com/chrischall/workday-mcp/commit/48ccc80a2892897977eee7f7cc13a9805c97de85))

## [1.1.0](https://github.com/chrischall/workday-mcp/compare/v1.0.0...v1.1.0) (2026-09-19)


### Features

* **deps:** take mcp-utils 1.0.0, so server/discover answers ([#112](https://github.com/chrischall/workday-mcp/issues/112)) ([b925715](https://github.com/chrischall/workday-mcp/commit/b925715605a677fbc46a7532473699fc3d99ac3c))

## [1.0.0](https://github.com/chrischall/workday-mcp/compare/v0.6.5...v1.0.0) (2026-09-18)


### ⚠ BREAKING CHANGES

* **mcp:** migrate server to SDK v2 ([#109](https://github.com/chrischall/workday-mcp/issues/109))

### Features

* **mcp:** migrate server to SDK v2 ([#109](https://github.com/chrischall/workday-mcp/issues/109)) ([857bff8](https://github.com/chrischall/workday-mcp/commit/857bff8f6b57e4a4ae7379c2ba4882e40187857e))


### Bug Fixes

* **deps:** Bump the production-dependencies group with 2 updates ([#107](https://github.com/chrischall/workday-mcp/issues/107)) ([d28d938](https://github.com/chrischall/workday-mcp/commit/d28d9383404a84da66ad59b4a477c740e2208998))

## [0.6.5](https://github.com/chrischall/workday-mcp/compare/v0.6.4...v0.6.5) (2026-09-15)


### Bug Fixes

* **deps:** @fetchproxy/server 3.0.1 — capped peer frames, logged load drops, atomic identity writes ([#103](https://github.com/chrischall/workday-mcp/issues/103)) ([59adf32](https://github.com/chrischall/workday-mcp/commit/59adf3292c952c59cf6bab0fcc840439d4512188))

## [0.6.4](https://github.com/chrischall/workday-mcp/compare/v0.6.3...v0.6.4) (2026-09-14)


### Bug Fixes

* **deps:** @fetchproxy/server 2.11.3, so the hosted extension pin persists ([#100](https://github.com/chrischall/workday-mcp/issues/100)) ([ebc8aed](https://github.com/chrischall/workday-mcp/commit/ebc8aed8c42f49d187afbba08433715fa1e0f297))
* **deps:** @fetchproxy/server 3.0.0 — protocol v4 (forward secrecy, AAD over the frame) ([#102](https://github.com/chrischall/workday-mcp/issues/102)) ([6553e69](https://github.com/chrischall/workday-mcp/commit/6553e69423578f121766724700753e6801876456))

## [0.6.3](https://github.com/chrischall/workday-mcp/compare/v0.6.2...v0.6.3) (2026-09-10)


### Bug Fixes

* **deps:** @fetchproxy/server 2.10.0 and @chrischall/mcp-utils 0.26.1 ([#97](https://github.com/chrischall/workday-mcp/issues/97)) ([0a67208](https://github.com/chrischall/workday-mcp/commit/0a67208f6783c38a38acb9891339194b9ddb938f))
* **deps:** take @fetchproxy/server 2.9.1 so a pairing prompt survives ([#95](https://github.com/chrischall/workday-mcp/issues/95)) ([4dffd21](https://github.com/chrischall/workday-mcp/commit/4dffd2137f607b8873dba8132a2925b7ea47ffac))

## [0.6.2](https://github.com/chrischall/workday-mcp/compare/v0.6.1...v0.6.2) (2026-09-09)


### Bug Fixes

* **deps:** require @fetchproxy/server ^2.7.0, the first that reads FETCHPROXY_IDENTITY_DIR ([#93](https://github.com/chrischall/workday-mcp/issues/93)) ([6e6e867](https://github.com/chrischall/workday-mcp/commit/6e6e8670cea5148680d9b4810272b92f11ea1cda))

## [0.6.1](https://github.com/chrischall/workday-mcp/compare/v0.6.0...v0.6.1) (2026-09-04)


### Documentation

* **skill:** document the `view` response-shape parameter ([#86](https://github.com/chrischall/workday-mcp/issues/86)) ([a923537](https://github.com/chrischall/workday-mcp/commit/a9235371f03c0179f91456dcf7ecd96475697de7))

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
