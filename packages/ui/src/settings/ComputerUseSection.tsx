// Computer Use 设置只投影插件 store 和只读原生状态；授权交给系统设置，不再编排私有 Helper 恢复链。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CuaPermissionKind, RemoteTarget } from "@zcode/shared";
import { isRemoteWorkspaceIdentity, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { isCuaPermissionStatusAvailable, type CuaPermissionState } from "@zcode/services";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useCuaPermissionStatus } from "@/hooks/useCuaPermissionStatus.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { supportsLocalMacCuaPermissionOnboarding } from "@/lib/cuaPlatform.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { StatusDot, type StatusDotTone } from "@/settings/StatusDot.js";
import { runAfterSuccessfulPluginEnabledChange } from "@/settings/pluginEnabledChange.js";
import { resolveComputerUseAvailability } from "@/settings/computerUseAvailability.js";

interface ComputerUseSectionProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  localWorkspacePath?: string | null;
}

export function ComputerUseSection({
  isDesktop = false,
  isMacDesktop,
  isWindowsDesktop = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  localWorkspacePath,
}: ComputerUseSectionProps) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const platform = usePlatform();
  const pluginManagementService = services.pluginManagementService;
  const isLocalWorkspace =
    !remoteSessionId &&
    !remoteTarget &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));
  const supportsLocalMacWorkspace =
    !isWindowsDesktop &&
    (isMacDesktop ?? supportsLocalMacCuaPermissionOnboarding(platform)) &&
    isLocalWorkspace;
  const supportsLocalWindowsWorkspace = isWindowsDesktop && isLocalWorkspace;
  const supportsComputerUseSettings = supportsLocalMacWorkspace || supportsLocalWindowsWorkspace;
  const availability = resolveComputerUseAvailability({
    isDesktop: isDesktop || isWindowsDesktop || supportsLocalMacWorkspace,
    isMacDesktop: isMacDesktop || supportsLocalMacWorkspace,
    isWindowsDesktop,
    remoteSessionId,
    remoteTarget,
    workspaceIdentity,
  });

  // 启停仍只有插件 store 一条写入路径；这里不维护第二份 enabled 状态。
  const plugins = usePluginManagementStore((state) => state.plugins);
  const setPluginEnabled = usePluginManagementStore((state) => state.setEnabled);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const cuaEnabled =
    plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID)?.enabled ?? false;
  const cuaToggling = togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID;
  const path = supportsComputerUseSettings ? (localWorkspacePath ?? workspacePath) : null;
  // Windows 也查询原生执行器；插件关闭、远端和 Web 均不触发本机状态查询。
  const { status, refresh } = useCuaPermissionStatus(
    cuaEnabled && !cuaToggling ? (path ?? null) : null,
    workspaceIdentity,
  );
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // 跨版本缓存中的旧 Helper granted 不能成为新执行器已验证的证据。
  const nativeStatus = status?.provider === "agent-desktop" ? status : null;
  const availableStatus =
    nativeStatus && isCuaPermissionStatusAvailable(nativeStatus) ? nativeStatus : null;

  const mountedRef = useRef(true);
  const pluginToggleGenerationRef = useRef(0);
  const contextKey = [
    workspacePath ?? "",
    workspaceIdentity ?? "",
    localWorkspacePath ?? "",
    remoteSessionId ?? "",
    remoteTarget ? "remote" : "local",
  ].join("\u0000");
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const permissionOperationRef = useRef<symbol | null>(null);
  const [openingPermission, setOpeningPermission] = useState<CuaPermissionKind | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pluginToggleGenerationRef.current += 1;
      permissionOperationRef.current = null;
    };
  }, []);
  useEffect(() => {
    permissionOperationRef.current = null;
    setOpeningPermission(null);
  }, [contextKey]);

  const initRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !supportsComputerUseSettings ||
      !workspacePath ||
      !pluginManagementService ||
      initRef.current === contextKey
    )
      return;
    initRef.current = contextKey;
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [
    supportsComputerUseSettings,
    workspacePath,
    workspaceIdentity,
    pluginManagementService,
    initializePlugins,
    contextKey,
  ]);

  const onTogglePlugin = useCallback(
    async (next: boolean) => {
      if (!pluginManagementService || !workspacePath || cuaToggling || !supportsComputerUseSettings)
        return;
      const generation = ++pluginToggleGenerationRef.current;
      const operationContextKey = contextKey;
      const isCurrent = () =>
        mountedRef.current &&
        pluginToggleGenerationRef.current === generation &&
        contextKeyRef.current === operationContextKey;
      const completed = await runAfterSuccessfulPluginEnabledChange({
        submit: () => setPluginEnabled(ZCODE_CUA_OFFICIAL_PLUGIN_ID, next, pluginManagementService),
        isCurrent,
        onSuccess: () => {
          // 启用只读状态，不自动打开系统权限或重启任何进程。
          if (next) refreshRef.current();
          else toast(intl.formatMessage({ id: "settings.computerUse.disabledToast" }));
        },
      });
      if (!completed && isCurrent()) {
        const message = usePluginManagementStore.getState().error;
        if (message) toast(message);
      }
    },
    [
      pluginManagementService,
      workspacePath,
      cuaToggling,
      supportsComputerUseSettings,
      contextKey,
      setPluginEnabled,
      refresh,
      intl,
    ],
  );

  const openPermissionSettings = useCallback(
    async (initialPermission: CuaPermissionKind) => {
      if (
        !supportsLocalMacWorkspace ||
        !cuaEnabled ||
        !availableStatus ||
        !platform.openCuaPermissionOnboarding ||
        permissionOperationRef.current
      )
        return;
      const operation = Symbol("native-cua-permission-settings");
      permissionOperationRef.current = operation;
      const operationContextKey = contextKey;
      const isCurrent = () =>
        mountedRef.current &&
        permissionOperationRef.current === operation &&
        contextKeyRef.current === operationContextKey;
      setOpeningPermission(initialPermission);
      try {
        const result = await platform.openCuaPermissionOnboarding({
          initialPermission,
          requiredPermissions: [initialPermission],
        });
        if (!isCurrent()) return;
        if (result.success === false && !result.canceled) {
          toast(
            intl.formatMessage(
              { id: "chat.cuaPermission.openFailed" },
              { error: result.error ?? intl.formatMessage({ id: "cuaPermission.status.unknown" }) },
            ),
          );
        }
        // 系统设置返回后也只读刷新；原生 runtime 持有进程和权限，不走旧 Helper restart。
        refresh();
      } catch (error) {
        if (isCurrent())
          toast(
            intl.formatMessage(
              { id: "chat.cuaPermission.openFailed" },
              { error: error instanceof Error ? error.message : String(error) },
            ),
          );
      } finally {
        if (isCurrent()) {
          permissionOperationRef.current = null;
          setOpeningPermission(null);
        }
      }
    },
    [supportsLocalMacWorkspace, cuaEnabled, availableStatus, platform, contextKey, intl, refresh],
  );

  const { settings: appSettings, update: updateAppSettings } = useSettings();
  const [composerEntryHiddenOverride, setComposerEntryHiddenOverride] = useState<boolean | null>(
    null,
  );
  const [composerEntrySaving, setComposerEntrySaving] = useState(false);
  const persistedComposerEntryHidden = appSettings?.computerUseComposerEntryHidden !== false;
  const composerEntryVisible = !(composerEntryHiddenOverride ?? persistedComposerEntryHidden);
  useEffect(() => {
    if (
      composerEntryHiddenOverride !== null &&
      persistedComposerEntryHidden === composerEntryHiddenOverride
    )
      setComposerEntryHiddenOverride(null);
  }, [composerEntryHiddenOverride, persistedComposerEntryHidden]);
  const onToggleComposerEntry = useCallback(
    async (visible: boolean) => {
      if (composerEntrySaving || !cuaEnabled) return;
      const nextHidden = !visible;
      setComposerEntryHiddenOverride(nextHidden);
      setComposerEntrySaving(true);
      try {
        // useSettings 同步共享 snapshot；直接调用 settingService 会让输入框保留旧按钮状态。
        await updateAppSettings({ computerUseComposerEntryHidden: nextHidden });
      } catch (error) {
        if (mountedRef.current) {
          setComposerEntryHiddenOverride(null);
          toast(
            intl.formatMessage(
              { id: "settings.computerUse.composerEntry.saveFailed" },
              { error: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      } finally {
        if (mountedRef.current) setComposerEntrySaving(false);
      }
    },
    [composerEntrySaving, cuaEnabled, updateAppSettings, intl],
  );

  const badge = (tone: StatusDotTone, text: string): ReactNode => (
    <SettingsBadge>
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone={tone} />
        {text}
      </span>
    </SettingsBadge>
  );
  const permissionView = (state?: CuaPermissionState): { tone: StatusDotTone; text: string } => ({
    tone:
      state === "granted"
        ? "green"
        : state === "denied"
          ? "red"
          : state === "stale"
            ? "amber"
            : "muted",
    text: intl.formatMessage({
      id:
        state === "granted"
          ? "cuaPermission.status.granted"
          : state === "denied"
            ? "cuaPermission.status.missing"
            : state === "stale"
              ? "cuaPermission.status.stale"
              : "cuaPermission.status.unknown",
    }),
  });
  const permissionRow = (
    kind: CuaPermissionKind,
    state: CuaPermissionState,
    labelId: string,
    descriptionId: string,
    actionId: string,
  ): ReactNode => {
    const view = permissionView(state);
    return (
      <SettingsRow
        key={kind}
        controlLayout="wide"
        label={intl.formatMessage({ id: labelId })}
        description={intl.formatMessage({ id: descriptionId })}
        control={badge(view.tone, view.text)}
        detail={
          state !== "granted" && platform.openCuaPermissionOnboarding ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-icon-blue"
              disabled={openingPermission !== null}
              aria-label={intl.formatMessage({ id: actionId })}
              onClick={() => void openPermissionSettings(kind)}
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">
                {intl.formatMessage({
                  id: openingPermission === kind ? "chat.cuaPermission.opening" : actionId,
                })}
              </span>
            </Button>
          ) : undefined
        }
      />
    );
  };

  if (!supportsComputerUseSettings)
    return (
      <div className="rounded-lg bg-warning-surface p-4 text-ui-base text-warning-surface-foreground">
        <p className="font-medium">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.title" })}
        </p>
        <p className="mt-1 text-ui-sm">
          {intl.formatMessage({
            id:
              availability.kind === "local-linux"
                ? "settings.computerUse.unsupported.linuxDescription"
                : availability.kind === "web"
                  ? "settings.computerUse.unsupported.webDescription"
                  : "settings.computerUse.unsupported.remoteDescription",
          })}
        </p>
      </div>
    );

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
          description={intl.formatMessage({ id: "settings.computerUse.toggleDescription" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
              checked={cuaEnabled}
              disabled={cuaToggling || !workspacePath || !pluginManagementService}
              onCheckedChange={(checked) => void onTogglePlugin(checked)}
            />
          }
        />
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.computerUse.composerEntry.label" })}
          description={intl.formatMessage({
            id: cuaEnabled
              ? "settings.computerUse.composerEntry.description"
              : "settings.computerUse.composerEntry.requiresEnabled",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.computerUse.composerEntry.label" })}
              checked={composerEntryVisible}
              disabled={composerEntrySaving || !cuaEnabled || !appSettings}
              onCheckedChange={(checked) => void onToggleComposerEntry(checked)}
            />
          }
        />
      </SettingsGroupCard>
      {cuaEnabled ? (
        <SettingsGroupCard>
          <SettingsRow
            controlLayout="wide"
            label={intl.formatMessage({ id: "settings.computerUse.native.title" })}
            description="agent-desktop"
            control={badge(
              availableStatus ? "green" : nativeStatus ? "red" : "muted",
              intl.formatMessage({
                id: availableStatus
                  ? "settings.computerUse.native.detected"
                  : nativeStatus
                    ? "settings.computerUse.native.unavailable"
                    : "cuaPermission.status.unknown",
              }),
            )}
            detail={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!path}
                onClick={() => refresh()}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.computerUse.native.refresh" })}
              </Button>
            }
          />
          <div className="space-y-2 border-t border-border px-4 py-3 text-ui-sm text-foreground-subtle">
            {availableStatus?.binaryPath ? (
              <p className="break-all font-mono select-text">{availableStatus.binaryPath}</p>
            ) : null}
            {!nativeStatus ? (
              <p>{intl.formatMessage({ id: "settings.computerUse.native.unconfirmed" })}</p>
            ) : nativeStatus.reason ? (
              <p role="status">{nativeStatus.reason}</p>
            ) : null}
            <p>
              {intl.formatMessage({
                id: supportsLocalMacWorkspace
                  ? "settings.computerUse.native.macHint"
                  : "settings.computerUse.native.windowsHint",
              })}
            </p>
          </div>
          {supportsLocalMacWorkspace && availableStatus ? (
            <>
              {permissionRow(
                "accessibility",
                availableStatus.accessibility,
                "cuaPermission.perm.accessibility",
                "cuaPermission.perm.accessibility.purpose",
                "chat.cuaPermission.openAccessibility",
              )}
              {permissionRow(
                "screen_recording",
                availableStatus.screenRecording,
                "cuaPermission.perm.screenRecording",
                "cuaPermission.perm.screenRecording.purpose",
                "chat.cuaPermission.openScreenRecording",
              )}
            </>
          ) : null}
        </SettingsGroupCard>
      ) : null}
    </div>
  );
}
