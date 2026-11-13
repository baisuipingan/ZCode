import { memo, useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";
import { getNextThoughtLevelValue } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import type { ComposerModelOptions } from "@/chat-input-toolbar/ComposerModelMenu.js";
import { ZCODE_AGENT_PROVIDER, type ModelSelection, type ZCodeConfigOption } from "@zcode/shared";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "./contract.js";
import {
  MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import type {
  ModelSelectionRefreshResult,
  ModelSelectionState,
} from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
import { useBrandAccount } from "./context.js";
import { BrandModelSyncStatus } from "./BrandModelSyncStatus.js";

const MODEL_OPTION: ZCodeConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "",
  options: [],
};
function noop() {}

interface BrandComposerModelControlsProps {
  modelSelectionView: ModelSelectionView | null;
  modelSelectionState: ModelSelectionState;
  modelSelectionRefresh?: () => Promise<ModelSelectionRefreshResult>;
  draftConfig?: Partial<SessionConfigState>;
  requestedSelection?: ModelSelection;
  disabled: boolean;
  activeConfigPicker: string | null;
  onConfigPickerOpenChange: (picker: "model", open: boolean) => void;
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: { provider: string; model: string } | null,
  ) => void;
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
}

/** 品牌界面消费现有 Registry/Composer owner，避免挂载官方供应商及套餐 hooks。 */
export const BrandComposerModelControls = memo(function BrandComposerModelControls({
  modelSelectionView,
  modelSelectionState,
  modelSelectionRefresh,
  draftConfig,
  requestedSelection,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectModel,
  onSelectThought,
}: BrandComposerModelControlsProps) {
  const { intl } = useZCodeIntl();
  const { snapshot, refreshAgentConfig } = useBrandAccount();
  const [openRequestKey, setOpenRequestKey] = useState(0);
  const shortcutLabel = useShortcutCommandLabel("openModelMenu");
  const thoughtShortcutLabel = useShortcutCommandLabel("cycleThoughtLevel");
  const refreshing = snapshot?.inference.refreshStatus === "refreshing";
  const pickerDisabled = disabled || snapshot?.status !== "authenticated";
  const modelLabel = intl.formatMessage({ id: "brandAccount.models.title" });
  const groups = useMemo<ModelSelectGroup[]>(() => {
    if (!modelSelectionView) return [];
    const items = buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView).flatMap(
      (group) => group.items,
    );
    return items.length > 0 ? [{ key: "brand-agent-models", label: modelLabel, items }] : [];
  }, [modelLabel, modelSelectionView]);
  // 原因：effectiveSelection 在目录移除模型时为空；原始草稿仍拥有用户意图，
  // 这里只投影不可用 ID，不能因此清空展示或恢复可提交配置。
  // 原因：有效投影会移除失效档位；展示必须保留草稿原意图，不能伪装成未选择。
  const selection = requestedSelection ?? draftConfig?.modelSelection;
  const value = selection ? encodeCustomModelValue(selection.providerId, selection.modelId) : "";
  const selected = groups[0]?.items.find((item) => item.value === value);
  const unavailable = Boolean(selection && modelSelectionView && !selected);
  const triggerLabel =
    selected?.name ?? selection?.modelId ?? intl.formatMessage({ id: "chat.toolbar.model.label" });
  const model = modelSelectionView?.providers
    .find((provider) => provider.providerId === selection?.providerId)
    ?.models.find((candidate) => candidate.modelId === selection?.modelId);
  const spec = model?.config.optionSpecs.reasoningLevel;
  const labelForLevel = useCallback(
    (level: string) => {
      // 品牌协议的 none 是省略 effort；不能沿用其他供应商的“关闭思考”标签。
      const id =
        level === "none" ? "brandAccount.models.upstreamDefault" : thoughtLevelLabelId(level);
      return id ? intl.formatMessage({ id }) : level;
    },
    [intl],
  );
  const levels = useMemo(
    () => spec?.values.map((level) => ({ value: level, label: labelForLevel(level) })) ?? [],
    [labelForLevel, spec],
  );
  const currentLevel = selection?.options?.reasoningLevel ?? "";
  const reasoningIssue =
    model && !levels.some((level) => level.value === currentLevel)
      ? intl.formatMessage(
          {
            id: currentLevel
              ? "brandAccount.models.reasoningInvalid"
              : "brandAccount.models.reasoningRequired",
          },
          { level: currentLevel },
        )
      : undefined;
  const selectThought = useCallback(
    (level: string) => {
      if (pickerDisabled || !selection || !levels.some((candidate) => candidate.value === level))
        return;
      onSelectThought(level, { provider: selection.providerId, model: selection.modelId });
    },
    [levels, onSelectThought, pickerDisabled, selection],
  );
  const thoughtOption = useMemo<ZCodeConfigOption | undefined>(
    () =>
      levels.length > 1
        ? {
            id: "brand-reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentLevel,
            options: levels.map((level) => ({ value: level.value, name: level.label })),
          }
        : undefined,
    [currentLevel, levels],
  );
  const cycleThought = useCallback(() => {
    const next = thoughtOption ? getNextThoughtLevelValue(thoughtOption) : null;
    if (next) selectThought(next);
  }, [selectThought, thoughtOption]);
  const composerOptions = useMemo<ComposerModelOptions>(
    () => ({
      showProviderNavigation: false,
      keepTriggerLabel: true,
      providerLabel: "",
      modelsLabel: modelLabel,
      effortLabel: intl.formatMessage({ id: "chat.toolbar.combined.effort" }),
      effortShortcutLabel: thoughtOption ? thoughtShortcutLabel : undefined,
      selectModelLabel: intl.formatMessage({ id: "chat.toolbar.combined.selectModel" }),
      levels,
      value: currentLevel,
      onValueChange: selectThought,
      selectionIssue: reasoningIssue,
      repairLabel: levels[0]
        ? intl.formatMessage(
            { id: "brandAccount.models.reasoningApply" },
            { level: levels[0].label },
          )
        : undefined,
      defaultHint: spec?.defaultLevel
        ? intl.formatMessage(
            { id: "brandAccount.models.reasoningDefault" },
            { level: labelForLevel(spec.defaultLevel) },
          )
        : undefined,
    }),
    [
      currentLevel,
      intl,
      labelForLevel,
      levels,
      modelLabel,
      reasoningIssue,
      selectThought,
      spec,
      thoughtOption,
      thoughtShortcutLabel,
    ],
  );
  const onValueChange = useCallback(
    (nextValue: string) => {
      const candidate = groups[0]?.items.find((item) => item.value === nextValue);
      const decoded = candidate ? decodeCustomModelValue(candidate.value) : null;
      if (!decoded?.modelName || pickerDisabled) return;
      // 原因：刷新不是用户改选；只有有效菜单点击才能写入既有 Composer 草稿 owner。
      onSelectModel(
        decoded.providerId,
        decoded.modelName,
        selection ? { provider: selection.providerId, model: selection.modelId } : null,
      );
    },
    [groups, onSelectModel, pickerDisabled, selection],
  );
  const onOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("model", open);
      if (open) void refreshAgentConfig({ force: false }).catch(noop);
    },
    [onConfigPickerOpenChange, refreshAgentConfig],
  );
  const refreshModels = useCallback(() => {
    void refreshAgentConfig({ force: true })
      .then(() => modelSelectionRefresh?.())
      .catch(noop);
  }, [modelSelectionRefresh, refreshAgentConfig]);
  const actions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "refresh-brand-models",
        label: intl.formatMessage({
          id: refreshing ? "brandAccount.models.refreshing" : "brandAccount.models.refresh",
        }),
        icon: (
          <RefreshCw
            className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
          />
        ),
        disabled: refreshing,
        keepOpen: true,
        onSelect: refreshModels,
      },
    ],
    [intl, refreshModels, refreshing],
  );
  const openModelMenu = useCallback(() => setOpenRequestKey((current) => current + 1), []);
  useToolbarShortcutBindings({
    hasAnyOption: true,
    toolbarDisabled: pickerDisabled,
    modelMenuDisabled: pickerDisabled,
    modelOption: MODEL_OPTION,
    thoughtOption,
    onOpenModelMenu: openModelMenu,
    onCycleSessionMode: noop,
    onCycleThoughtLevel: cycleThought,
  });
  return (
    <ModelConfigSelect
      composerOptions={composerOptions}
      modelGroups={groups}
      normalizedValue={value}
      triggerLabel={triggerLabel}
      showProviderLevel={false}
      showManageModelsAction={false}
      lockReasonMessage=""
      isItemLocked={neverLocked}
      onValueChange={onValueChange}
      disabled={pickerDisabled}
      tooltipTitle={
        unavailable
          ? intl.formatMessage(
              { id: "brandAccount.models.unavailableSelection" },
              { model: triggerLabel },
            )
          : (reasoningIssue ?? triggerLabel)
      }
      shortcutLabel={shortcutLabel}
      open={activeConfigPicker === "model"}
      onOpenChange={onOpenChange}
      openRequestKey={openRequestKey}
      triggerBadge={
        unavailable ? (
          <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>
            {intl.formatMessage({ id: "brandAccount.models.unavailable" })}
          </span>
        ) : reasoningIssue ? (
          <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>
            {intl.formatMessage({ id: "brandAccount.models.reasoningSelect" })}
          </span>
        ) : undefined
      }
      labelVisibilityClassName="inline-flex"
      triggerLabelClassName="block min-w-0 max-w-40 truncate text-left"
      triggerClassName="min-w-0"
      footerActions={actions}
      footerStatus={
        <div className="space-y-1 px-2 py-1">
          {modelSelectionState.status === "error" ? (
            <p role="alert" className="text-ui-xs text-warning">
              {intl.formatMessage({ id: "brandAccount.models.catalogFailed" })}
            </p>
          ) : groups.length === 0 ? (
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "brandAccount.models.empty" })}
            </p>
          ) : null}
          <BrandModelSyncStatus />
        </div>
      }
      focusSelectorOnClose={`[data-testid="${TID_V4_COMPOSER_INPUT}"]`}
    />
  );
});

function neverLocked() {
  return false;
}
