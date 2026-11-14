import type { AgentDesktopAssetContract } from "./contract";

export async function prepareMacComputerUseAssets(assets: AgentDesktopAssetContract) {
  const plan = await assets.prepare({ platform: "darwin", arch: "arm64" });
  if (!plan) throw new Error("Unsupported Computer Use build target");
  await assets.verify(plan);
  return plan.binaryPath;
}
