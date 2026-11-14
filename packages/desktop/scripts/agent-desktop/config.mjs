import { resolve } from "node:path";

export const AGENT_DESKTOP_VERSION = "1.3.1";
export const AGENT_DESKTOP_PROVIDER = "vercel-agent-desktop";
export const AGENT_DESKTOP_SOURCE = "https://github.com/vercel-labs/agent-desktop";
export const AGENT_DESKTOP_LICENSE_SHA256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
export const agentDesktopScriptRoot = import.meta.dirname;
export const agentDesktopPackageRoot = resolve(agentDesktopScriptRoot, "../..");

const releases = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    archiveSha256: "9b7b7cfc74892eab46c2c85d6cb7dc4863bf8dab0a222cfcfb8ae4604c69c86c",
    binaryName: "agent-desktop",
    files: {
      "agent-desktop": "9a6b0829736a486da532a9d1ceed1e07192fa8967326c7b27125646adab6baf7",
      "agent-desktop-macos-helper":
        "87348178e546974ee0f96b74dd03410f61f4972cae5eb5fbd36bf04d2cb50a42",
    },
  },
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    archiveSha256: "6ee4b1e078f4e78792e79f16e32e4a78b9919464aa3c55629b7e27ed53a08c13",
    binaryName: "agent-desktop.exe",
    files: {
      "agent-desktop.exe": "a7ef5e539fb97287a35eb9ed49d3803b4d6bd705bc4106eb28617229f9be679e",
    },
  },
};

export function getAgentDesktopRelease({ platform, arch }) {
  const key = `${platform}-${arch}`;
  const release = releases[key];
  if (!release) return null;
  const archiveName = `agent-desktop-v${AGENT_DESKTOP_VERSION}-${release.triple}.tar.gz`;
  return {
    ...release,
    files: { ...release.files },
    platform,
    arch,
    key,
    version: AGENT_DESKTOP_VERSION,
    archiveName,
    archiveUrl: `${AGENT_DESKTOP_SOURCE}/releases/download/v${AGENT_DESKTOP_VERSION}/${archiveName}`,
  };
}

export function resolveAgentDesktopResources({
  platform,
  arch,
  desktopRoot = agentDesktopPackageRoot,
  resourcesDir,
}) {
  const release = getAgentDesktopRelease({ platform, arch });
  if (!release) return null;
  const directory = resourcesDir
    ? resolve(resourcesDir, "agent-desktop")
    : resolve(desktopRoot, "resources", "agent-desktop", release.key);
  return { ...release, directory, binaryPath: resolve(directory, release.binaryName) };
}

export function getAgentDesktopExtraResources(target, desktopRoot = agentDesktopPackageRoot) {
  const plan = resolveAgentDesktopResources({ ...target, desktopRoot });
  return plan ? [{ from: plan.directory, to: "agent-desktop", filter: ["**/*"] }] : [];
}

export function resolveAgentDesktopBuilderTarget({ electronPlatformName, arch, configuredTarget }) {
  const actualArch = { 1: "x64", 3: "arm64" }[arch];
  if (electronPlatformName !== configuredTarget.os || actualArch !== configuredTarget.arch) {
    throw new Error(
      `agent-desktop build target mismatch: configured ${configuredTarget.key}, actual ${electronPlatformName}-${String(actualArch ?? arch)}`,
    );
  }
  return { platform: electronPlatformName, arch: actualArch };
}
