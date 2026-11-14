import type { AgentDesktopProvider } from "./contract.js";

export async function queryDesktopPermissions(provider: AgentDesktopProvider) {
  // Permissions are read-only and do not depend on the Computer Use plugin being enabled.
  return provider.getPermissionStatus();
}
