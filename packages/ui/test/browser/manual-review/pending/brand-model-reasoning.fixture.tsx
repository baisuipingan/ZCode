// 真实菜单、Composer draft owner、目录订阅和提交冻结；只替换外部Host目录，不调用付费模型。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import { normalizeModelSelection } from "@zcode/provider";
import type { IServiceAccessor, IModelSelectionService, ModelSelectionView } from "@zcode/services";
import type { IPlatformService, ModelSelection } from "@zcode/shared";
import { BrandComposerModelControls } from "@/brand-account/BrandComposerModelControls.js";
import { BrandAccountContext } from "@/brand-account/context.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
document.documentElement.className = `${query.get("theme") ?? "dark"} theme-zai-${query.get("theme") ?? "dark"}`;
const providerId = "fixture-managed";
const selection = (modelId: string, reasoningLevel?: string): ModelSelection => ({
  providerId,
  modelId,
  ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
});
function model(modelId: string, levels: string[], defaultLevel: string) {
  return {
    modelId,
    displayName: `Model ${modelId}`,
    config: {
      enabled: true,
      properties: {
        requiresMfjsToolSchema: false,
        contextWindow: 128000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsAudio: false,
          supportsVideo: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
      },
      optionSpecs: {
        reasoningLevel: {
          values: levels,
          defaultLevel,
          map: 'reasoningLevel == "none" ? {} : {"reasoning":{"effort":reasoningLevel}}',
        },
        maxOutputTokens: { max: 8192, map: '{"max_output_tokens":maxOutputTokens}' },
      },
    },
  };
}
let catalog: ModelSelectionView = {
  revision: 1,
  preferredSelection: selection("Alpha", "medium"),
  providers: [
    {
      providerId,
      config: {
        api: { type: "openai-responses", baseUrl: "https://fixture.invalid/v1" },
        access: {
          type: query.has("apiKey") ? "api-key" : "brand-managed",
          credentialRef: "fixture",
          billingBinding: {
            origin: "https://fixture.invalid",
            accountRef: "fixture:1",
            accountEpoch: 1,
            policyRevision: "fixture",
          },
        },
      },
      models: [
        model("Alpha", ["low", "medium", "high"], "medium"),
        model("Beta", ["minimal", "xhigh", "max"], "xhigh"),
        model("Fixed", ["low"], "low"),
        model("Auto", ["none"], "none"),
      ],
    },
  ],
} as ModelSelectionView;
const changed = new Emitter<ModelSelectionView>();
const directory = {
  getView: async (input) => {
    const requested = input?.selection ?? catalog.preferredSelection;
    return {
      ...catalog,
      effectiveSelection: requested ? (normalizeModelSelection(catalog, requested) ?? null) : null,
    };
  },
  onDidChange: changed.event,
} as IModelSelectionService;
const services = {
  settingService: { get: async () => ({}) },
  zcodeSessionService: {},
} as unknown as IServiceAccessor;

function Fixture() {
  const [picker, setPicker] = useState<string | null>(null);
  const [providerPending, setProviderPending] = useState(true);
  const [repairedLevel, setRepairedLevel] = useState("");
  const [accepted, setAccepted] = useState<ReturnType<typeof createComposerSubmissionConfig>>(null);
  const owner = useDraftConfigControl({
    workspacePath: "/fixture/reasoning",
    sessionId: null,
    agentStartupAllowed: false,
    modelSelectionService: directory,
  });
  const state = owner.modelSelectionRead.state;
  const view =
    state.status === "ready"
      ? state.view
      : state.status === "loading" && state.catalog
        ? state.catalog
        : null;
  const submission = createComposerSubmissionConfig(
    owner.composerDraft,
    state.status === "ready" ? state.view : null,
  );
  Object.assign(window, {
    __brandPendingRepair: { value: repairedLevel, setPending: setProviderPending },
    __brandReasoning: {
      selection: owner.composerDraft.modelSelection,
      submission,
      accepted,
      restore: (modelId: string, level?: string) =>
        owner.replaceComposerDraft({
          text: "KEEP_DRAFT",
          mode: "build",
          modelSelection: selection(modelId, level),
        }),
      changeCatalog: (modelId: string, levels: string[], defaultLevel: string) => {
        catalog = {
          ...catalog,
          revision: catalog.revision + 1,
          providers: catalog.providers.map((provider) => ({
            ...provider,
            models: provider.models.map((current) =>
              current.modelId === modelId ? model(modelId, levels, defaultLevel) : current,
            ),
          })),
        };
        changed.fire(catalog);
      },
      removeModel: (modelId: string) => {
        catalog = {
          ...catalog,
          revision: catalog.revision + 1,
          providers: catalog.providers.map((provider) => ({
            ...provider,
            models: provider.models.filter((current) => current.modelId !== modelId),
          })),
        };
        changed.fire(catalog);
      },
    },
  });
  if (query.has("sharedPending")) {
    const groups = [
      {
        key: "pending-group",
        label: "API",
        items: [{ key: "fixed", value: "fixed", name: "Fixed" }],
      },
    ];
    return (
      <ModelConfigSelect
        modelGroups={groups}
        normalizedValue="fixed"
        triggerLabel="Fixed"
        showManageModelsAction={false}
        lockReasonMessage=""
        isItemLocked={() => false}
        onValueChange={() => {}}
        focusSelectorOnClose={null}
        composerOptions={{
          providerMenu: {
            groups,
            selectedKey: "pending-group",
            pending: providerPending,
            error: null,
            onSelect: () => {},
          },
          providerLabel: "Provider",
          modelsLabel: "Models",
          effortLabel: "Reasoning",
          selectModelLabel: "Select model",
          levels: [{ value: "low", label: "Low" }],
          value: repairedLevel,
          onValueChange: setRepairedLevel,
        }}
      />
    );
  }
  return (
    <BrandAccountContext.Provider
      value={{
        enabled: true,
        service: null,
        snapshot: {
          status: "authenticated",
          inference: {
            status: "configured",
            refreshStatus: "idle",
            lastSuccessfulAt: 1234,
            refreshError: null,
          },
        } as never,
        initializationFailed: false,
        initialize: async () => {},
        refreshBalance: async () => {},
        refreshAgentConfig: async () => {},
        openRecharge: () => {},
      }}
    >
      <main className="min-h-screen bg-background p-4 text-ui-base text-foreground">
        <div className="max-w-xl rounded-xl border border-border p-3">
          <div contentEditable suppressContentEditableWarning data-testid="v4-composer-input">
            KEEP_DRAFT
          </div>
          <div className="mt-3 flex min-w-0 items-center justify-between gap-2">
            <BrandComposerModelControls
              modelSelectionView={view}
              modelSelectionState={state}
              draftConfig={owner.draftConfig}
              requestedSelection={owner.composerDraft.modelSelection}
              disabled={false}
              activeConfigPicker={picker}
              onConfigPickerOpenChange={(_, open) => setPicker(open ? "model" : null)}
              onSelectModel={(provider, modelId) => owner.handleDraftSelectModel(provider, modelId)}
              onSelectThought={(level) => owner.handleDraftSelectThought(level)}
            />
            <button
              data-testid="accept"
              disabled={!submission}
              onClick={() => setAccepted(submission)}
            >
              Accept
            </button>
          </div>
        </div>
        <output className="hidden" data-testid="selection">
          {JSON.stringify(owner.composerDraft.modelSelection)}
        </output>
      </main>
    </BrandAccountContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={{} as IPlatformService}>
      <ZCodeIntlProvider initialLocale={query.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
        <TooltipProvider>
          <TabStoreProvider>
            <Fixture />
          </TabStoreProvider>
        </TooltipProvider>
      </ZCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
