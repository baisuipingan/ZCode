import type { MiloCodeSignedUpdateInfo, MiloCodeUpdateTrustPolicy } from "./contract.js";
import { verifyMiloCodeUpdateArtifact } from "./index.js";

/** Main 先冻结目标，准备真正交给安装器时校验同一版本及文件，失败不得继续退出。 */
export function verifyFrozenMiloCodeInstaller(
  installerPath: string,
  update: MiloCodeSignedUpdateInfo,
  policy: MiloCodeUpdateTrustPolicy,
) {
  return verifyMiloCodeUpdateArtifact(installerPath, update.milocodeSignedEnvelope, policy, {
    expectedVersion: update.version,
  });
}
