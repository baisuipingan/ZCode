import type { AgentDesktopAssetPlan, AgentDesktopTarget } from "./contract.js";

export const AGENT_DESKTOP_VERSION: "1.3.1";
export const AGENT_DESKTOP_PROVIDER: "vercel-agent-desktop";
export const AGENT_DESKTOP_SOURCE: string;
export const AGENT_DESKTOP_LICENSE_SHA256: string;
export const agentDesktopScriptRoot: string;
export const agentDesktopPackageRoot: string;

export function getAgentDesktopRelease(
  target: AgentDesktopTarget,
): Omit<AgentDesktopAssetPlan, "directory" | "binaryPath"> | null;

export function resolveAgentDesktopResources(
  target: AgentDesktopTarget & { desktopRoot?: string; resourcesDir?: string },
): AgentDesktopAssetPlan | null;

export function getAgentDesktopExtraResources(
  target: AgentDesktopTarget,
  desktopRoot?: string,
): Array<{ from: string; to: string; filter: string[] }>;

export function resolveAgentDesktopBuilderTarget(options: {
  electronPlatformName: string;
  arch: number;
  configuredTarget: { os: string; arch: string; key: string };
}): AgentDesktopTarget;
