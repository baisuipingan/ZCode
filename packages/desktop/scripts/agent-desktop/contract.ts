export interface AgentDesktopTarget {
  platform: string;
  arch: string;
}

/** 固定上游发行资源的构建准备与验收；不是运行时下载接口。 */
export interface AgentDesktopAssetPlan extends AgentDesktopTarget {
  version: string;
  key: string;
  directory: string;
  binaryPath: string;
  archiveUrl: string;
  archiveName: string;
  archiveSha256: string;
  binaryName: string;
  triple: string;
  files: Readonly<Record<string, string>>;
}

export interface AgentDesktopAssetContract {
  resolve(
    target: AgentDesktopTarget & { desktopRoot?: string; resourcesDir?: string },
  ): AgentDesktopAssetPlan | null;
  prepare(
    target: AgentDesktopTarget & { desktopRoot?: string; cacheRoot?: string },
  ): Promise<AgentDesktopAssetPlan | null>;
  verify(target: AgentDesktopTarget & { directory: string }): Promise<AgentDesktopAssetPlan>;
}
