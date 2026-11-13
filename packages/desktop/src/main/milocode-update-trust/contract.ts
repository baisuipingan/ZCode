import type { UpdateInfo } from "electron-updater";

export type {
  MiloCodeReleaseFile,
  MiloCodeReleasePayload,
  MiloCodeUpdateTrustPolicy,
} from "../../../scripts/milocode-release-trust.mjs";

/** 可序列化的签名原文随冻结目标进入缓存；恢复安装时必须重新验签和校验文件。 */
export interface MiloCodeSignedUpdateInfo extends UpdateInfo {
  readonly milocodeSignedEnvelope: string;
  readonly zcodeReleaseChannel: "stable";
}
