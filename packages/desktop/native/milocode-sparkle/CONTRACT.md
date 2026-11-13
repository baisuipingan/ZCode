# MiloCode Sparkle native bridge

The Electron Main process calls this Node-API addon on the Cocoa main thread after
`app.whenReady()`. Sparkle owns its single download/install transaction and native
window. Main owns task confirmation and asynchronous Host/Agent quit preparation.

Public methods:

- `start(callback)`: validate the bundle's fixed HTTPS `SUFeedURL`, 32-byte
  `SUPublicEDKey`, signed-feed and pre-extraction verification configuration, then
  start the standard Sparkle controller. No private keys or arbitrary runtime feed
  overrides enter this boundary.
- `checkForUpdates()`: focus/check via Sparkle, or re-request approval for an
  already postponed installation.
- `resolveInstall(requestId, allow)`: only the pending request may be released.
  Rejection keeps it retryable. Approval consumes its continuation once after Main
  has completed quit preparation.
- `dispose()`: detach callbacks during normal shutdown; it does not install.

Events have `kind`, and optional `version`, `requestId`, `message`. Kinds are
`checking`, `update-available`, `not-available`, `downloading`, `downloaded`,
`install-request`, `installing`, `error`, `idle`. Native windows show download
progress; React must not open a second update window.

The global Electron quit barrier remains mandatory because Sparkle can resume an
installation without calling its postpone delegate again. Automatic downloads and
automatic installs must stay disabled for this product shape. A fixture-only
Info.plist flag permits loopback HTTP for isolated runtime verification; production
packaging must never include it. This does not weaken archive/feed signature checks.

Ordinary archives only: same-origin HTTPS ZIP application updates, no package
installers, extra scripts, alternate channels, system-profile telemetry or dynamic
trust roots.

The typed public boundary is `contract.ts`. `version` in native events always names
the target bundle, not the running bundle. A request token belongs to the one native
transaction; stale or duplicate approvals throw. Main must serialize its
confirmation/preparation flow, ignore stale event results during disposal, and keep
the existing global quit barrier active. Declining an install preserves the native
continuation; a later `checkForUpdates()` emits the same request token again.

The build entry point is `scripts/milocode-sparkle-runtime.mjs`:

- `ensureSparkleDistribution()` downloads the official pinned Sparkle archive,
  verifies SHA256 before extraction, and caches the framework and release tools.
- `prepareMacSparkleRuntime({ targetArch, outDir })` compiles the Node-API bridge
  and stages `milocode_sparkle.node`, `Sparkle.framework`, `SPARKLE-LICENSE`, and
  `sparkle-runtime.json`. It uses no release private key.
- Packaging must put the addon/license under
  `Contents/Resources/milocode-update/` and the framework under
  `Contents/Frameworks/`. Do not copy a second framework into Resources. The addon
  rpaths support this installed layout and the adjacent-framework engineering
  layout.
- The production `Info.plist` fixes `SUFeedURL`, `MiloCodeReleaseBaseURL`, `SUPublicEDKey`,
  `SURequireSignedFeed=true`, `SUVerifyUpdateBeforeExtraction=true`,
  `SUSignedFeedFailureExpirationInterval=0`, `SUAllowsAutomaticUpdates=false`, and
  `SUAutomaticallyUpdate=false`. Keep the public key stable between releases. Both
  URLs share one HTTPS origin; archive URLs must be under the fixed release base's
  `releases/` directory with no credentials, query, or fragment. Deltas are rejected.
- `engineeringTest: true` compiles an isolated native-button test driver. It must
  never be used when packaging a release. The normal addon has no such export.

`scripts/milocode-sparkle-smoke.mjs` creates isolated ad-hoc Electron fixtures and
temporary signing keys outside the real installation and user data. It validates
two consecutive native updates, rejecting/retrying each install confirmation, and
preserving a user-data sentinel. It never changes Gatekeeper, Keychain, the real
MiloCode installation, or system trust. This verifies the unsigned/ad-hoc update
mechanism on the local Mac; it does not certify first launch on a clean Mac or
remove normal macOS security prompts.
