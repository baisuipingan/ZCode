import {
  createAgentDesktopRuntime,
  isAgentDesktopConfigured,
} from "./src/agent-desktop/index.js";

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

export function createComputerUseRuntime(options = {}) {
  const env = options.env ?? process.env;
  if (env.ZCODE_CUA_NODE_REPL_HOST === "1" && isAgentDesktopConfigured(env)) {
    return createAgentDesktopRuntime(options);
  }
  return {
    async execute() {
      return {
        content: [{ type: "text", text: UNAVAILABLE_TEXT }],
        isError: true,
      };
    },
    async closeSession() {},
    async dispose() {},
  };
}
