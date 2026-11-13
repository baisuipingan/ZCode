import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { UpdateStatusDialog } from "@/UpdateStatusDialog.js";
import { formatUpdateReleaseDate } from "@/updateReleaseNotes.js";
import {
  deriveUpdateStatusViewModel,
  isUpdateActionCompleted,
  type UpdateActionInFlight,
  type UpdateStatusViewModel,
} from "@/updateStatusModel.js";

export function UpdateStatusDialogController({
  platform,
  version,
  updateState,
  open,
  onOpenChange,
  edgeToEdge = false,
  showOverlay = true,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edgeToEdge?: boolean;
  showOverlay?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const [updateActionInFlight, setUpdateActionInFlightState] = useState<UpdateActionInFlight>(null);
  const updateActionInFlightRef = useRef<typeof updateActionInFlight>(null);
  const releaseDateCacheRef = useRef(new Map<string, string>());
  const setUpdateActionInFlight = useCallback((nextAction: typeof updateActionInFlight) => {
    updateActionInFlightRef.current = nextAction;
    setUpdateActionInFlightState(nextAction);
  }, []);
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const lastVisibleUpdateStatusViewModelSelection = useRef<UpdateStatusViewModel | null>(null);
  const renderedUpdateStatusViewModel =
    updateStatusViewModel.displayVersion || updateActionInFlight === null
      ? updateStatusViewModel
      : (lastVisibleUpdateStatusViewModelSelection.current ?? updateStatusViewModel);
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    progressValue,
    releaseNotesPayload: updateReleaseNotesPayload,
    skippableVersion,
  } = renderedUpdateStatusViewModel;
  const formattedReleaseDate = formatUpdateReleaseDate(
    updateReleaseNotesPayload?.releaseDate,
    locale,
  );
  const releaseNotesCacheKey = displayVersion ? `${locale}:${displayVersion}` : null;

  useEffect(() => {
    if (!updateStatusViewModel.displayVersion) {
      return;
    }

    // 点击“下载更新”后，真实下载进度依赖 main 侧异步广播。
    // 中间若短暂收到 checking/idle 等不带版本的过渡状态，不能让入口 return null
    // 连带卸载已打开的弹窗；命令进行中复用上一帧可见模型，等进度态收口。
    lastVisibleUpdateStatusViewModelSelection.current = updateStatusViewModel;
  }, [updateStatusViewModel]);

  useEffect(() => {
    if (!releaseNotesCacheKey || !formattedReleaseDate) {
      return;
    }

    // 下载完成事件可能只含 version，缓存当前版本日期，避免标题日期闪失。
    releaseDateCacheRef.current.set(releaseNotesCacheKey, formattedReleaseDate);
    if (releaseDateCacheRef.current.size > 8) {
      const oldestCacheKey = releaseDateCacheRef.current.keys().next().value;
      if (oldestCacheKey) {
        releaseDateCacheRef.current.delete(oldestCacheKey);
      }
    }
  }, [formattedReleaseDate, releaseNotesCacheKey]);

  const cachedReleaseDate = releaseNotesCacheKey
    ? releaseDateCacheRef.current.get(releaseNotesCacheKey)
    : undefined;
  const restoredReleaseDate = formattedReleaseDate ?? cachedReleaseDate ?? null;
  const handleDownloadUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    // 如果 electron-updater 命中本地已下载缓存，main 侧会直接广播
    // update-downloaded。renderer 不能在 IPC ACK 前后乐观切到“下载中”，否则会闪过
    // 一帧无意义的 0%/下载态；这里只锁按钮，真实阶段完全跟随 main 的状态广播。
    setUpdateActionInFlight("download");
    try {
      await platform.downloadUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleCancelDownload = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    setUpdateActionInFlight("cancel");
    try {
      await platform.cancelUpdateDownload();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleSkipUpdate = useCallback(async () => {
    if (!skippableVersion || updateActionInFlightRef.current) {
      return;
    }
    setUpdateActionInFlight("skip");
    try {
      await platform.skipUpdateVersion(skippableVersion);
      onOpenChange(false);
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [onOpenChange, platform, setUpdateActionInFlight, skippableVersion]);
  const handleRestartUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    // 重启安装之前是 fire-and-forget，renderer 发完 IPC 就关闭弹窗。
    // dev/mock 下 updater 若没有接管安装，用户只会看到弹窗消失，误以为按钮没有响应。
    setUpdateActionInFlight("restart");
    try {
      // 安装中断确认由 Main 的最后退出屏障唯一负责，避免 Renderer 再弹一次。
      await platform.quitAndInstallUpdate();
    } finally {
      // Main 正常返回也可能是用户取消；必须解锁，不能只在异常时释放等待状态。
      setUpdateActionInFlight(null);
    }
  }, [platform, setUpdateActionInFlight]);

  useEffect(() => {
    if (!displayVersion && updateState !== null) {
      onOpenChange(false);
    }
  }, [displayVersion, onOpenChange, updateState]);

  useEffect(() => {
    if (!updateActionInFlight) {
      return;
    }

    if (isUpdateActionCompleted(updateActionInFlight, updateState)) {
      setUpdateActionInFlight(null);
      return;
    }

    // 退出准备和 Windows 安装器交接可能超过 5 秒；旧的统一 ACK 定时器会在
    // 应用真正退出前恢复“重启以更新”，让用户误判失败并重复点击。restart 成功路径保持
    // pending 直到 IPC 完成或应用退出，正常取消和异常均由调用处 finally 恢复按钮。
    if (updateActionInFlight === "restart") {
      if (updateState !== null && updateState.kind !== "update-downloaded") {
        // main 会在退出准备失败时广播 error/idle。即使 IPC reject 因窗口
        // 生命周期丢失，状态已经离开 ready 也必须释放按钮，不能保留上一帧永久 pending。
        setUpdateActionInFlight(null);
      }
      return;
    }

    // 下载/取消 IPC 在 main 进程会立即 ACK，真实状态靠后续广播收口。
    // 连点时需要先锁住按钮；若广播丢失或 main 侧 no-op，也要短超时释放，避免 UI 自己卡住。
    const timeout = globalThis.setTimeout(() => {
      setUpdateActionInFlight(null);
    }, 1500);

    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [setUpdateActionInFlight, updateActionInFlight, updateState?.kind]);

  if (!displayVersion) return null;

  const releaseDateLabel = restoredReleaseDate
    ? intl.formatMessage({ id: "updateDialog.releaseDate" }, { date: restoredReleaseDate })
    : null;

  return (
    <UpdateStatusDialog
      displayVersion={displayVersion}
      edgeToEdge={edgeToEdge}
      intl={intl}
      isUpdateActionPending={updateActionInFlight !== null}
      onCancelDownload={handleCancelDownload}
      onDownloadUpdate={handleDownloadUpdate}
      onOpenChange={onOpenChange}
      onRestartUpdate={handleRestartUpdate}
      onSkipUpdate={handleSkipUpdate}
      open={open}
      phase={dialogPhase}
      progressLabel={progressLabel}
      progressValue={progressValue}
      releaseDateLabel={releaseDateLabel}
      showOverlay={showOverlay}
      skippableVersion={skippableVersion}
    />
  );
}
