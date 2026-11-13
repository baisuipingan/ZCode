import { createBrowserAuthorizationFixture } from "./browser-login-fixture.js";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";

export const MI_MODEL = "e2e-managed-responses";
export const MI_CONTENT = "E2E_MI05_REAL_TOOL_WRITE_AND_READ\n";
export const MI_SECRETS = ["E2E_MI_ACCESS_", "E2E_MI_REFRESH_", "E2E_MI_AGENT_", "E2E_MI_PASSWORD"];

export function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function createManagedInferenceFixture(outputFile: string) {
  const state = {
    browserUserId: 1,
    requests: [] as Array<{ method: string; path: string; auth: string }>,
    modelRequests: [] as Array<{
      path: string;
      model: string;
      stream: boolean;
      workClass: "main" | "title" | "compact";
      account: number;
      step: number;
      sawReadResult: boolean;
      reasoningEffort: string | null;
    }>,
    violations: [] as string[],
    titleObserved: latch(),
    bootstrapGate: null as {
      started: ReturnType<typeof latch>;
      finish: ReturnType<typeof latch>;
    } | null,
    meGate: null as { started: ReturnType<typeof latch>; finish: ReturnType<typeof latch> } | null,
    meFailureStatus: 0,
    publicSettingsFailureStatus: 0,
    balanceOverride: null as number | null,
    bootstrapStatus: "ready" as "ready" | "disabled" | "credential_blocked",
    bootstrapReason: null as string | null,
    credentialKey: null as string | null,
    overrideApiBase: null as string | null,
    overrideModel: null as Record<string, unknown> | null,
    overrideModels: null as Array<Record<string, unknown>> | null,
    schemaVersion: 2,
    configRevision: "e2e-mi-1",
    overrideSelection: null as Record<string, unknown> | null,
    bootstrapRejectOnce: false,
    bootstrapFailureStatus: 0,
    configurationChangedResponses: 0,
    unavailableModels: [] as Array<{ model_id: string; display_name: string; reason_code: string }>,
    noDefault: false,
    authorizationScope: "a".repeat(64),
    credentialExpiresAt: null as string | null,
    usageGate: null as {
      started: ReturnType<typeof latch>;
      finish: ReturnType<typeof latch>;
    } | null,
    usageFails: false,
    usageEmpty: false,
    mainSteps: new Map<number, number>(),
    logins: 0,
    refreshes: 0,
  };
  const access = new Map<string, number>();
  const refresh = new Map<string, number>();
  let tokenSequence = 0;
  let baseUrl = "";
  const user = (id: number) => ({
    id,
    email: `e2e-mi-${id}@example.invalid`,
    username: `E2E MI ${id}`,
    balance: state.balanceOverride ?? (id === 1 ? 12.34 : 56.78),
    frozen_balance: 0,
  });
  const tokens = (id: number) => {
    tokenSequence += 1;
    const a = `E2E_MI_ACCESS_${id}_${tokenSequence}`;
    const r = `E2E_MI_REFRESH_${id}_${tokenSequence}`;
    access.set(a, id);
    refresh.set(r, id);
    return { access_token: a, refresh_token: r, expires_in: 3600, token_type: "Bearer" };
  };
  const usage = {
    input_tokens: 40,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  function textResponse(text: string) {
    return {
      id: "resp_e2e_mi_text",
      object: "response",
      created_at: 1,
      model: MI_MODEL,
      status: "completed",
      error: null,
      incomplete_details: null,
      usage,
      output: [
        {
          id: "msg_e2e_mi",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    };
  }
  function streamResponse(response: ServerResponse, step: number) {
    const id = `resp_e2e_mi_${step}`;
    const frames: Record<string, unknown>[] = [
      { type: "response.created", response: { id, created_at: 1, model: MI_MODEL } },
    ];
    if (step < 3) {
      const item = {
        type: "function_call",
        // 当前Responses SDK只在done事件的completed项发出tool-call；缺少此字段
        // 会留下输入流但以schema错误结束，不能把它误报成真实工具执行失败。
        status: "completed",
        id: `fc_e2e_mi_${step}`,
        call_id: `call_e2e_mi_${step}`,
        name: step === 1 ? "Write" : "Read",
        arguments: JSON.stringify(
          step === 1 ? { file_path: outputFile, content: MI_CONTENT } : { file_path: outputFile },
        ),
      };
      frames.push(
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        },
        { type: "response.output_item.done", output_index: 0, item },
      );
    } else {
      const item = {
        id: `msg_e2e_mi_${step}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "E2E_MI05_DONE: created and read the real file.",
            annotations: [],
          },
        ],
      };
      frames.push(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: item.id },
        },
        {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: item.content[0]!.text,
        },
        { type: "response.output_item.done", output_index: 0, item },
      );
    }
    frames.push({ type: "response.completed", response: { id, status: "completed", usage } });
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    );
  }
  const browserAuthorization = createBrowserAuthorizationFixture(() => state.browserUserId);
  const server = createServer(async (request, response) => {
    if (browserAuthorization.authorize(request, response)) return;
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const authorization = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
    const account = access.get(authorization);
    const agentAccount =
      authorization === "E2E_MI_AGENT_1" ? 1 : authorization === "E2E_MI_AGENT_2" ? 2 : undefined;
    state.requests.push({
      method: request.method ?? "",
      path,
      auth: agentAccount ? `agent-${agentAccount}` : account ? `login-${account}` : "none",
    });
    const reply = (data: unknown, status = 200) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          code: status === 200 ? 0 : status,
          message: status === 200 ? "ok" : "E2E rejection",
          data,
        }),
      );
    };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (path === "/api/v1/settings/public" && state.publicSettingsFailureStatus)
        return reply({}, state.publicSettingsFailureStatus);
      if (path === "/api/v1/settings/public")
        return reply({
          site_name: "E2E MI",
          registration_enabled: false,
          password_reset_enabled: false,
          turnstile_enabled: false,
          tencent_captcha_enabled: false,
          aliyun_captcha_enabled: false,
          payment_enabled: false,
          payment_balance_disabled: true,
          billing_currency_enabled: true,
          billing_engine: "credits",
          billing_display_currency: "USD",
          billing_usd_to_cny: 6.75,
          billing_settings_version: 1,
        });
      if (path === "/api/v1/desktop/auth/token") {
        const id = browserAuthorization.exchange(body);
        if (!id) return reply({}, 400);
        state.logins += 1;
        return reply({ ...tokens(id), user: user(id) });
      }
      if (path === "/api/v1/auth/login") {
        state.logins += 1;
        const id = body.email === "e2e-mi-2@example.invalid" ? 2 : 1;
        return reply({ ...tokens(id), user: user(id) });
      }
      if (path === "/api/v1/auth/refresh") {
        state.refreshes += 1;
        const id = refresh.get(String(body.refresh_token));
        refresh.delete(String(body.refresh_token));
        return id ? reply(tokens(id)) : reply({}, 401);
      }
      if (path === "/api/v1/auth/logout") return reply({});
      if (path === "/v1/responses") {
        assert(agentAccount, "Responses must receive Agent credential, never login JWT");
        assert.equal(body.model, MI_MODEL);
        assert(
          typeof body.max_output_tokens === "number" &&
            body.max_output_tokens > 0 &&
            body.max_output_tokens <= 4096,
          "Responses must enforce the managed output budget",
        );
        assert(
          !MI_SECRETS.some((secret) => raw.includes(secret)),
          "Model request body must not contain secrets",
        );
        const title = raw.includes("Generate a concise title");
        const compact = raw.includes("CRITICAL: Respond with TEXT ONLY");
        const step = title || compact ? 0 : (state.mainSteps.get(agentAccount) ?? 0) + 1;
        if (step) state.mainSteps.set(agentAccount, step);
        const sawReadResult =
          Array.isArray(body.input) &&
          body.input.some((item: unknown) => {
            if (!item || typeof item !== "object") return false;
            const value = item as Record<string, unknown>;
            return (
              value.type === "function_call_output" &&
              value.call_id === "call_e2e_mi_2" &&
              JSON.stringify(value.output).includes(MI_CONTENT.trim())
            );
          });
        state.modelRequests.push({
          path,
          model: String(body.model),
          stream: body.stream === true,
          workClass: title ? "title" : compact ? "compact" : "main",
          account: agentAccount,
          step,
          sawReadResult,
          reasoningEffort:
            typeof (body.reasoning as { effort?: unknown } | undefined)?.effort === "string"
              ? String((body.reasoning as { effort: string }).effort)
              : null,
        });
        if (title) state.titleObserved.release();
        if (title || compact) {
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          return response.end(
            JSON.stringify(
              textResponse(
                title
                  ? '{"title":"E2E Managed Tool Loop"}'
                  : "<summary>E2E_MI_COMPACT managed summary.</summary>",
              ),
            ),
          );
        }
        assert(step <= 3, "Unexpected extra main model request");
        assert.equal(body.stream, true);
        const tools = JSON.stringify(body.tools);
        assert(
          tools.includes('"Write"') && tools.includes('"Read"'),
          "Real runtime must expose Write and Read",
        );
        if (step === 3) assert(sawReadResult, "Final request must carry actual Read tool result");
        return streamResponse(response, step);
      }
      assert(!agentAccount, "Account endpoints must not receive inference credentials");
      if (!account) return reply({}, 401);
      if (path === "/api/v1/auth/me") {
        if (state.meFailureStatus) return reply({}, state.meFailureStatus);
        const captured = user(account);
        const gate = state.meGate;
        state.meGate = null;
        gate?.started.release();
        if (gate) await gate.finish.promise;
        return reply(captured);
      }
      if (path === "/api/v1/payment/config")
        return reply({
          enabled: false,
          balance_disabled: true,
          min_amount: 1,
          max_amount: 100,
          order_timeout_minutes: 30,
        });
      if (path === "/api/v1/payment/checkout-info") return reply({ methods: {} });
      if (path === "/api/v1/payment/orders/my")
        return reply({ items: [], total: 0, page: 1, page_size: 20 });
      if (path === "/api/v1/desktop/bootstrap") {
        assert.equal(request.method, "POST");
        assert.equal(body.protocol_version, 3);
        assert(["darwin", "win32"].includes(String(body.platform)));
        assert(
          Object.keys(body).every((key) =>
            ["client_version", "protocol_version", "platform", "installation_id"].includes(key),
          ),
        );
        if (state.bootstrapRejectOnce) {
          state.bootstrapRejectOnce = false;
          return reply({}, 401);
        }
        if (state.bootstrapFailureStatus) return reply({}, state.bootstrapFailureStatus);
        if (state.configurationChangedResponses > 0) {
          state.configurationChangedResponses -= 1;
          return reply({
            schema_version: state.schemaVersion,
            config_revision: state.configRevision,
            service_status: "not_configured",
            reason_code: "configuration_changed",
          });
        }
        const gate = state.bootstrapGate;
        state.bootstrapGate = null;
        gate?.started.release();
        if (gate) await gate.finish.promise;
        if (state.bootstrapStatus !== "ready")
          return reply({
            schema_version: state.schemaVersion,
            config_revision: state.configRevision,
            service_status: state.bootstrapStatus,
            reason_code: state.bootstrapReason ?? state.bootstrapStatus,
          });
        return reply({
          schema_version: state.schemaVersion,
          config_revision: state.configRevision,
          service_status: "ready",
          reason_code: "ready",
          provider: {
            id: "milorouter-managed",
            api_type: "openai-responses",
            base_url: state.overrideApiBase ?? `${baseUrl}/v1`,
          },
          models: state.overrideModels ?? [
            {
              id: MI_MODEL,
              display_name: "E2E Managed Responses",
              context_window: 128000,
              max_output_tokens: 8192,
              default_max_output_tokens: 4096,
              reasoning_levels: ["none"],
              default_reasoning: "none",
              supports_reasoning: false,
              supports_streaming: true,
              requires_mfjs_tool_schema: false,
              input: { text: true, image: false, video: false, audio: false, pdf: false },
              output: { text: true },
              supports_tool_call: true,
              supports_json_schema_output: false,
              supports_native_web_search: false,
              supports_mid_conversation_system: true,
              ...state.overrideModel,
            },
          ],
          ...(state.schemaVersion === 3 ? { unavailable_models: state.unavailableModels } : {}),
          selection_policy:
            state.schemaVersion === 3
              ? {
                  default: state.noDefault
                    ? null
                    : {
                        model_id: MI_MODEL,
                        reasoning_level: "none",
                        max_output_tokens: 4096,
                        ...state.overrideSelection,
                      },
                  auxiliary: "inherit-main",
                }
              : {
                  model_id: MI_MODEL,
                  reasoning_level: "none",
                  max_output_tokens: 4096,
                  auxiliary: "inherit-main",
                  ...state.overrideSelection,
                },
          credential: {
            id: String(100 + account),
            key: state.credentialKey ?? `E2E_MI_AGENT_${account}`,
            scope: "e2e-managed",
            expires_at: state.credentialExpiresAt,
            ...(state.schemaVersion === 3 ? { authorization_scope: state.authorizationScope } : {}),
          },
        });
      }
      if (path === "/api/v1/usage") {
        const query = new URL(request.url!, baseUrl).searchParams;
        assert.equal(query.get("api_key_id"), String(100 + account));
        assert.equal(query.get("page"), "1");
        assert.equal(query.get("page_size"), "20");
        const capturedEmpty = state.usageEmpty;
        const gate = state.usageGate;
        state.usageGate = null;
        gate?.started.release();
        if (gate) await gate.finish.promise;
        if (state.usageFails) return reply({}, 503);
        const items = capturedEmpty
          ? []
          : [
              {
                request_id: `E2E_MI12_CREDITS_${account}`,
                model: MI_MODEL,
                created_at: "2026-11-11T01:00:00Z",
                charge_credits: 9007199254740992,
                charge_credits_string: "9007199254740993",
                credits_per_usd: 1000000000,
                credits_per_usd_string: "1000000000",
                actual_cost: 9007199.254740993,
              },
              {
                request_id: `E2E_MI12_LEGACY_${account}`,
                model: MI_MODEL,
                created_at: "2026-11-11T00:59:00Z",
                charge_credits: 0,
                charge_credits_string: "0",
                credits_per_usd: 1000000000,
                credits_per_usd_string: "1000000000",
                actual_cost: 0.0123,
              },
            ];
        return reply({ items, total: items.length, page: 1, page_size: 20 });
      }
      state.violations.push(`Unexpected ${request.method} ${path}`);
      return reply({}, 404);
    } catch (error) {
      state.violations.push(String(error));
      if (!response.headersSent) reply({}, 500);
      else response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    state,
    baseUrl,
    async close() {
      state.bootstrapGate?.finish.release();
      state.meGate?.finish.release();
      state.usageGate?.finish.release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
