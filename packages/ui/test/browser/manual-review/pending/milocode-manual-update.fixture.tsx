// 验收真实更新弹窗和设置组件；只记录平台动作，不连接发布源或启动安装器。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GeneralSectionContent } from "@/settingsPageHelpers.js";
import { UpdateStatusDialog } from "@/UpdateStatusDialog.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import type { IPlatformService } from "@zcode/shared";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { UpdateStatusDialogPhase } from "@/updateStatusModel.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "zh-CN" ? "zh-CN" : "en-US";
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const actions: string[] = [];
Object.assign(window, { __updateActions: actions });
const ignore = async () => {};
let resolveInstall: (() => void) | undefined;
Object.assign(window, { __resolveUpdateInstall: () => resolveInstall?.() });
const platform = {
  async quitAndInstallUpdate() {
    actions.push("install");
    await new Promise<void>((resolve) => {
      resolveInstall = resolve;
    });
  },
  async getDesktopSessionActivity() {
    actions.push("unexpected-renderer-confirm");
    return { runningAgentSessionCount: 1 };
  },
} as unknown as IPlatformService;

function Fixture() {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(true);
  if (params.get("surface") === "controller") {
    return (
      <UpdateStatusDialogController
        platform={platform}
        version="3.17.3"
        updateState={{
          kind: "update-downloaded",
          enabled: true,
          version: "3.17.3",
        }}
        open={open}
        onOpenChange={setOpen}
      />
    );
  }
  if (params.get("surface") === "settings") {
    return (
      <main className="mx-auto max-w-4xl p-4">
        <GeneralSectionContent
          localePreference={locale}
          notificationEnabled={false}
          notificationSoundEnabled={false}
          closeToTrayOnWindows={false}
          desktopChromiumHardwareAccelerationEnabled
          receivePreviewUpdates
          autoDownloadAndInstallUpdates
          dataBaseDir=""
          defaultHomeDir="/fixture/data"
          terminalInheritSystemProfile
          terminalFontFamily=""
          nativeSearchEnhancementsEnabled={false}
          isDesktop
          setLocalePreference={() => {}}
          setNotificationEnabled={() => {}}
          setNotificationSoundEnabled={() => {}}
          messageStreamShowReasoning
          messageStreamShowTodos
          toolGroupingExploreEnabled
          toolGroupingTerminalEnabled
          toolGroupingChangesEnabled
          zcodeInteractionBehavior="queue"
          onDataBaseDirChange={ignore}
          onSelectDataBaseDir={async () => null}
          onTerminalInheritSystemProfileChange={ignore}
          onTerminalFontFamilyChange={ignore}
          onToolSearchModeChange={ignore}
          onNativeSearchEnhancementsEnabledChange={ignore}
          onCloseToTrayOnWindowsChange={ignore}
          onDesktopChromiumHardwareAccelerationChange={async () => {
            actions.push("hardware");
          }}
          onReceivePreviewUpdatesChange={ignore}
          onAutoDownloadAndInstallUpdatesChange={ignore}
          onMessageStreamShowReasoningChange={ignore}
          onMessageStreamShowTodosChange={ignore}
          onToolGroupingExploreEnabledChange={ignore}
          onToolGroupingTerminalEnabledChange={ignore}
          onToolGroupingChangesEnabledChange={ignore}
          onZCodeInteractionBehaviorChange={ignore}
          onOpenOnboardingDialog={() => {}}
        />
      </main>
    );
  }
  return (
    <UpdateStatusDialog
      displayVersion="3.17.3"
      intl={intl}
      isUpdateActionPending={params.has("pending")}
      onCancelDownload={async () => {
        actions.push("cancel");
      }}
      onDownloadUpdate={async () => {
        actions.push("download");
      }}
      onOpenChange={(next) => {
        actions.push("later");
        setOpen(next);
      }}
      onRestartUpdate={async () => {
        actions.push("install");
      }}
      onSkipUpdate={async () => {
        actions.push("skip");
      }}
      open={open}
      phase={
        (params.get("phase") ?? "before-download") as UpdateStatusDialogPhase
      }
      progressLabel="35%"
      progressValue={35}
      releaseDateLabel="2026-11-13"
      skippableVersion="3.17.3"
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <Fixture />
  </ZCodeIntlProvider>,
);
