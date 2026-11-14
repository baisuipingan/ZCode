# @zcode/zcode-cua

MiloCode Computer Use runtime, powered by the pinned Vercel `agent-desktop`
v1.3.1 release (Apache-2.0). macOS ARM64 and Windows x64 native assets are
prepared at build time and shipped with the desktop application.

The public runtime keeps the existing Node REPL broker, main-agent token ledger,
workspace identity isolation and cancellation. The plugin uses
`agent.computerUse.desktop.tools/call/stop/emit`; native snapshots and refs are
preserved without emulating the former private Helper API.

`computerUseProvider: "agent-desktop"` identifies the open provider.
`zcodeCuaPlaceholder: true` continues to describe **only the legacy private
Helper/broker/PiP surfaces**. Do not remove it to enable Computer Use: that would
run build steps for private components that are absent from this repository.

See `docs/fork/39-computer-use-agent-desktop.md` for ownership, supported platforms,
permission behavior and validation boundaries. No model, API key, cloud agent loop
or runtime installation is added by this package.
