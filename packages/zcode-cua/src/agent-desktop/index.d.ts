import type { ComputerUseRuntime } from "../../index.js";
import type { CuaPermissionStatusResult } from "../../broker.js";
import type { AgentDesktopRuntimeOptions } from "./contract.js";

export type {
  AgentDesktopRuntimeOptions,
  AgentDesktopProvider,
} from "./contract.js";
export declare function isAgentDesktopConfigured(
  env?: Record<string, string | undefined>,
): boolean;
export declare function getAgentDesktopPermissionStatus(
  env?: Record<string, string | undefined>,
): Promise<CuaPermissionStatusResult>;
export declare function createAgentDesktopRuntime(
  options?: AgentDesktopRuntimeOptions,
): ComputerUseRuntime;
