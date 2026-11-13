import type { MiloCodeSparkleNativeBridge } from "./contract.js";

/** Main's global quit barrier must also cover native relaunch/recovery paths. */
export function connectMiloCodeSparkle(
  native: MiloCodeSparkleNativeBridge,
  confirmAndPrepareQuit: () => Promise<boolean>,
) {
  native.start((event) => {
    if (event.kind !== "install-request" || !event.requestId) return;
    const requestId = event.requestId;
    void confirmAndPrepareQuit().then(
      (allow) => native.resolveInstall(requestId, allow),
      () => native.resolveInstall(requestId, false),
    );
  });
}
