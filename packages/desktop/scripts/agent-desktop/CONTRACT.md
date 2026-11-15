# Agent desktop release assets

This build adapter owns the pinned agent-desktop v1.3.1 native resources and their provenance. It prepares macOS arm64/x64 and Windows x64 only. Unsupported targets return `null`, and never download an alternative version or search PATH. Each architecture pins its own official archive and exact member SHA256 digests; macOS x64 uses the verified `x86_64-apple-darwin` release.

Public build APIs live in `config.mjs` (release, source/packaged paths, Electron Builder resource entries) and `assets.mjs` (prepare and SHA-256/layout verification). `contract.ts` describes their aggregate intent. Desktop runtime receives an absolute binary path from its host; this module does not own sessions, actions, credentials or permissions.

Preparation downloads the fixed HTTPS release into `.cache/agent-desktop`, verifies the archive SHA-256, checks exact archive members, extracts to a private temporary directory, verifies every native file and licensing record, and then replaces the generated target directory. Cache hits must pass the same checks. Standard proxy environment variables are honored by curl during builds only.

Source layout: `resources/agent-desktop/<platform>-<arch>/`. Package layout: `resources/agent-desktop/agent-desktop[.exe]`, with the macOS `agent-desktop-macos-helper` beside the executable. Each target includes LICENSE, NOTICE and SOURCES.json. `afterPack` verifies the actual target and all bytes before signing; platform signing may subsequently change native signatures. Original closed-source Helper gates stay independent.

Regression: `pnpm --filter @zcode/desktop test:agent-desktop-assets`. Real resource preparation and cross-platform package-directory validation additionally verify pinned release bytes without executing Windows assets on macOS. No runtime download or updater behavior is added.
