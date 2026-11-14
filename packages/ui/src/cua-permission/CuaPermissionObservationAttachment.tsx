import { useEffect, useState } from "react";
import type { CuaAccessibilitySettingsResult, CuaPermissionKind } from "@zcode/shared";
import { isRemoteWorkspaceIdentity, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { requiredCuaPermissionsForRequestAccessStatus } from "@zcode/shared/zcode-protocol-v4";
import {
  isCuaPermissionStatusAvailable,
  type CuaPermissionRestartOptions,
  type CuaPermissionStatusResult,
  type ZCodeAgentCuaPermissionObservation,
} from "@zcode/services";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { shouldRestartHelperAfterCuaPermissionReturn } from "@/lib/cuaPermissionAction.js";
import { createCuaPermissionOnboardingOperationId } from "@/lib/cuaPermissionOnboardingOperation.js";
import {
  cuaPermissionStatusKey,
  fetchCuaPermissionStatus,
  getCuaPermissionStatusSnapshot,
  subscribeCuaPermissionStatus,
} from "@/lib/cuaPermissionStatusStore.js";
import { supportsLocalMacCuaPermissionOnboarding } from "@/lib/cuaPlatform.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { logger } from "@/logger.js";
import { requiredCuaPermissionsForFreshStatus } from "@/settings/cuaPermissionPreparation.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

export const CUA_APPLICATION_REMINDER_STORAGE_KEY = "milocode-cua-application-reminder-v1";

interface CuaApplicationReminderRecord {
  identity: string;
  pending: boolean;
}

function readCuaApplicationReminder(storage: Storage): CuaApplicationReminderRecord | null {
  const raw = storage.getItem(CUA_APPLICATION_REMINDER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<CuaApplicationReminderRecord>;
    return typeof record.identity === "string" &&
      record.identity.length > 0 &&
      typeof record.pending === "boolean"
      ? { identity: record.identity, pending: record.pending }
      : null;
  } catch {
    return null;
  }
}

function writeCuaApplicationReminder(storage: Storage, record: CuaApplicationReminderRecord): void {
  storage.setItem(CUA_APPLICATION_REMINDER_STORAGE_KEY, JSON.stringify(record));
}

async function withCuaApplicationReminderLock(
  operation: (storage: Storage) => void,
): Promise<void> {
  // localStorage 的读改写不是 CAS。用同 origin 的排它锁协调窗口；无法可靠消费时静默，
  // 设置页仍保留恢复指引，不能为了提示在每个窗口重复打扰或另起权限探针。
  if (typeof navigator.locks?.request !== "function") return;
  try {
    await navigator.locks.request(CUA_APPLICATION_REMINDER_STORAGE_KEY, () => {
      operation(window.localStorage);
    });
  } catch {
    // 本地 UI 提醒不是权限真值。隐私模式或存储不可用时不弹，也不影响电脑控制。
  }
}

/** 设备本地的非阻断提示；不查询插件、TCC、原生执行器或账户设置。 */
export function CuaApplicationUpgradeReminderAttachment() {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const activeTab = useOptionalTabStore(
    (state) => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
  );
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const pluginWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const plugins = usePluginManagementStore((state) => state.plugins);
  const pluginsLoading = usePluginManagementStore((state) => state.loading);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const localTab =
    activeTab?.kind === "workspace" &&
    !activeTab.remoteSessionId &&
    !activeTab.remoteTarget &&
    !(
      activeTab.workspaceIdentity?.trim() &&
      isRemoteWorkspaceIdentity(activeTab.workspaceIdentity.trim())
    )
      ? activeTab
      : null;
  const supported = supportsLocalMacCuaPermissionOnboarding(platform) && Boolean(localTab);
  const [identity, setIdentity] = useState<string | null>(null);

  useEffect(() => {
    if (!supported || !platform.getCuaApplicationInfo) {
      setIdentity(null);
      return;
    }
    let disposed = false;
    void platform
      .getCuaApplicationInfo()
      .then(async (info) => {
        if (disposed || !info?.identity) return;
        const currentIdentity = info.identity;
        await withCuaApplicationReminderLock((storage) => {
          if (disposed) return;
          const previous = readCuaApplicationReminder(storage);
          if (!previous || previous.identity !== currentIdentity) {
            writeCuaApplicationReminder(storage, {
              identity: currentIdentity,
              // 首次无法区分新装和旧版升级，先静默建立基线。
              pending: previous !== null,
            });
          }
        });
        if (!disposed) setIdentity(currentIdentity);
      })
      .catch(() => {
        // 元数据读取失败时不猜测身份，也不触发补救副作用。
      });
    return () => {
      disposed = true;
    };
  }, [platform, supported]);

  const pluginConfirmedEnabled = Boolean(
    localTab &&
    !pluginsLoading &&
    // User 配置视图刻意忽略工作区覆盖，不能据此把工作区已关闭的插件当作启用。
    pluginConfigScope !== "user" &&
    pluginWorkspacePath === localTab.workspacePath &&
    (pluginWorkspaceIdentity?.trim() || "") === (localTab.workspaceIdentity?.trim() || "") &&
    togglingPluginId !== ZCODE_CUA_OFFICIAL_PLUGIN_ID &&
    plugins.some((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID && plugin.enabled),
  );
  const workspacePath = localTab?.localWorkspacePath ?? localTab?.workspacePath;
  const workspaceIdentity = localTab?.workspaceIdentity;

  useEffect(() => {
    if (!supported || !identity || !workspacePath || !pluginConfirmedEnabled) return;
    let disposed = false;
    const evaluate = () => {
      void withCuaApplicationReminderLock((storage) => {
        if (disposed) return;
        const record = readCuaApplicationReminder(storage);
        if (!record?.pending || record.identity !== identity) return;
        const snapshot = getCuaPermissionStatusSnapshot(
          cuaPermissionStatusKey(workspacePath, workspaceIdentity),
        );
        // 冷启动持久缓存 fresh=false，不能拿旧版本的 granted 抑制当前版本提示。
        const status = snapshot.status;
        const granted =
          snapshot.fresh &&
          status?.provider === "agent-desktop" &&
          isCuaPermissionStatusAvailable(status) &&
          status.accessibility === "granted" &&
          status.screenRecording === "granted";
        if (!granted && !document.hasFocus()) return;
        // 先持久化消费，再展示。其余窗口获得同一锁后会看到 pending=false。
        writeCuaApplicationReminder(storage, { identity, pending: false });
        if (granted) return;
        toast(intl.formatMessage({ id: "cuaPermission.upgradeReminder" }), {
          variant: "info",
          durationMs: 15_000,
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "common.close" }),
          dedupeKey: CUA_APPLICATION_REMINDER_STORAGE_KEY,
          actionLabel: intl.formatMessage({ id: "cuaPermission.upgradeReminder.check" }),
          onAction: () => {
            setPendingSettingsSectionIntent("computerUse");
            openSettingsTab();
          },
        });
      });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === CUA_APPLICATION_REMINDER_STORAGE_KEY || event.key === null) evaluate();
    };
    const unsubscribe = subscribeCuaPermissionStatus(evaluate);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", evaluate);
    evaluate();
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", evaluate);
    };
  }, [
    identity,
    intl,
    openSettingsTab,
    pluginConfirmedEnabled,
    supported,
    workspaceIdentity,
    workspacePath,
  ]);

  return null;
}

interface CuaPermissionPromptDependencies {
  getStatus(): Promise<CuaPermissionStatusResult>;
  confirm(required: CuaPermissionKind[]): Promise<boolean>;
  openOnboarding(required: CuaPermissionKind[]): Promise<CuaAccessibilitySettingsResult>;
  restartHelper(options: CuaPermissionRestartOptions): Promise<{ ok: boolean; reason?: string }>;
  refresh(): void;
  isDisposed?(): boolean;
}

const CUA_PERMISSION_RETRY_DELAY_MS = 500;

function assertCuaPermissionPromptActive(dependencies: CuaPermissionPromptDependencies): void {
  if (dependencies.isDisposed?.()) throw new Error("CUA permission prompt disposed");
}

async function runWithOneRetry<T>(
  dependencies: CuaPermissionPromptDependencies,
  operation: () => Promise<T>,
  failureReason?: (result: T) => string | undefined,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertCuaPermissionPromptActive(dependencies);
    try {
      const result = await operation();
      assertCuaPermissionPromptActive(dependencies);
      const reason = failureReason?.(result);
      if (reason) throw new Error(reason);
      return result;
    } catch (error) {
      if (attempt === 1 || dependencies.isDisposed?.()) throw error;
      await new Promise((resolve) => setTimeout(resolve, CUA_PERMISSION_RETRY_DELAY_MS));
    }
  }
  throw new Error("CUA permission retry exhausted");
}

export function cuaPermissionObservationKey(
  observation: ZCodeAgentCuaPermissionObservation,
): string {
  const workspaceKey = observation.workspaceIdentity?.trim() || observation.workspacePath;
  const missing = requiredCuaPermissionsForRequestAccessStatus(observation.permissionStatus);
  return [
    workspaceKey,
    observation.sessionId,
    observation.turnId ?? observation.eventId,
    missing.join(","),
  ].join("\0");
}

export async function runCuaPermissionPrompt(
  dependencies: CuaPermissionPromptDependencies,
): Promise<void> {
  const readMissing = async () => {
    const status = await runWithOneRetry(dependencies, dependencies.getStatus);
    return isCuaPermissionStatusAvailable(status)
      ? requiredCuaPermissionsForFreshStatus(status)
      : [];
  };
  const beforeConfirm = await readMissing();
  if (beforeConfirm.length === 0) return;
  assertCuaPermissionPromptActive(dependencies);
  if (!(await dependencies.confirm(beforeConfirm))) return;
  assertCuaPermissionPromptActive(dependencies);

  // 原因：确认框停留期间可能已从另一窗口授权，打开设置前必须再读一次 Helper 真值。
  const afterConfirm = await readMissing();
  if (afterConfirm.length === 0) return;
  const result = await runWithOneRetry(
    dependencies,
    () => dependencies.openOnboarding(afterConfirm),
    (value) =>
      !value.success && !value.canceled
        ? `CUA permission onboarding failed: ${value.error ?? "unknown"}`
        : undefined,
  );
  if (result.canceled) return;
  if (shouldRestartHelperAfterCuaPermissionReturn(result)) {
    // 原因：Helper 重启失败时只能重试重启本身，重复打开系统设置会打断用户操作。
    await runWithOneRetry(
      dependencies,
      () =>
        dependencies.restartHelper({
          reason: "permission_granted",
          ...(result.sessionId ? { onboardingSessionId: result.sessionId } : {}),
        }),
      (value) => (value.ok ? undefined : `CUA Helper restart failed: ${value.reason ?? "unknown"}`),
    );
  }
  if (result.success && result.returnedFromSettings) {
    assertCuaPermissionPromptActive(dependencies);
    dependencies.refresh();
  }
}

export function CuaPermissionObservationAttachment() {
  const services = useServices();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const { intl } = useZCodeIntl();

  useEffect(() => {
    const permissionService = services.cuaPermissionService;
    if (
      !permissionService ||
      !platform.openCuaPermissionOnboarding ||
      typeof services.zcodeAgentService.onDynamicCuaPermissionObservation !== "function"
    ) {
      return;
    }

    const handled = new Set<string>();
    const pending = new Set<string>();
    let chain = Promise.resolve();
    let activeOperationId: string | null = null;
    let disposed = false;
    const subscription = services.zcodeAgentService.onDynamicCuaPermissionObservation()(
      (observation) => {
        const missing = requiredCuaPermissionsForRequestAccessStatus(observation.permissionStatus);
        const key = cuaPermissionObservationKey(observation);
        if (disposed || missing.length === 0 || handled.has(key) || pending.has(key)) return;
        pending.add(key);

        chain = chain.then(async () => {
          if (disposed) return;
          try {
            await runCuaPermissionPrompt({
              getStatus: () =>
                permissionService.getStatus(
                  observation.workspacePath,
                  observation.workspaceIdentity,
                  { includeFunctionalProbes: false },
                ),
              confirm: () =>
                confirmDialog({
                  title: intl.formatMessage({ id: "cuaPermission.live.title" }),
                  description: intl.formatMessage({ id: "cuaPermission.live.description" }),
                  confirmLabel: intl.formatMessage({ id: "cuaPermission.live.confirm" }),
                  cancelLabel: intl.formatMessage({ id: "cuaPermission.live.cancel" }),
                }),
              openOnboarding: async (required) => {
                const operationId = createCuaPermissionOnboardingOperationId();
                activeOperationId = operationId;
                try {
                  return (
                    (await platform.openCuaPermissionOnboarding?.({
                      operationId,
                      initialPermission: required[0],
                      requiredPermissions: required,
                    })) ?? { success: false, error: "unavailable" }
                  );
                } finally {
                  if (activeOperationId === operationId) activeOperationId = null;
                }
              },
              restartHelper: (options) =>
                permissionService.restartHelper(
                  observation.workspacePath,
                  observation.workspaceIdentity,
                  options,
                ),
              refresh: () =>
                fetchCuaPermissionStatus({
                  service: permissionService,
                  workspacePath: observation.workspacePath,
                  workspaceIdentity: observation.workspaceIdentity,
                  options: { includeFunctionalProbes: false },
                }),
              isDisposed: () => disposed,
            });
            if (disposed) return;
            // 原因：只有正常终态（包括用户取消）才能去重；异常必须允许同一 observation 再次处理。
            handled.add(key);
            if (handled.size > 2_000) {
              const oldest = handled.values().next().value;
              if (typeof oldest === "string") handled.delete(oldest);
            }
          } catch (error: unknown) {
            if (!disposed) logger.warn("CUA 权限引导失败", { error });
          } finally {
            pending.delete(key);
          }
        });
      },
    );
    return () => {
      // 原因：先封闭生命周期边界，避免已排队任务在 subscription 释放后继续触发旧 workspace 副作用。
      disposed = true;
      subscription.dispose();
      if (activeOperationId) platform.cancelCuaPermissionOnboarding?.(activeOperationId);
    };
  }, [confirmDialog, intl, platform, services]);

  return <CuaApplicationUpgradeReminderAttachment />;
}
