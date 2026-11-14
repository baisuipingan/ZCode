import type {
  ComputerUseRuntime,
  ComputerUseRuntimeOptions,
} from "../../index.js";
import type { CuaPermissionStatusResult } from "../../broker.js";

export interface AgentDesktopRuntimeOptions extends ComputerUseRuntimeOptions {
  /** Trusted host parser; absent parsers fail closed on nonempty identities. */
  isRemoteWorkspaceIdentity?: (identity: string) => boolean;
}

export interface AgentDesktopProvider {
  isConfigured(env?: Record<string, string | undefined>): boolean;
  getPermissionStatus(
    env?: Record<string, string | undefined>,
  ): Promise<CuaPermissionStatusResult>;
  createRuntime(options?: AgentDesktopRuntimeOptions): ComputerUseRuntime;
}
