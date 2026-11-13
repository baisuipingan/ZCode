import type { UpdateStatePayload } from "@zcode/shared";

export interface MiloCodeMacUpdaterOptions {
  onState: (state: UpdateStatePayload) => void;
  confirmInstall: () => boolean | Promise<boolean>;
  onBeforeInstall: () => void | Promise<void>;
  onInstallFailure: () => void;
}

export interface MiloCodeMacUpdater {
  checkForUpdates(): void;
  dispose(): void;
}
