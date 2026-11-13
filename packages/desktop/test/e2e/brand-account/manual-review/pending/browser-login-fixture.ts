import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ElectronApplication } from "playwright-core";

/** 合成网站授权：只替代浏览器确认页，真实Host仍执行loopback、PKCE与换证。 */
export function createBrowserAuthorizationFixture(selectedUser: () => number) {
  const codes = new Map<string, { challenge: string; redirect: string; user: number }>();
  return {
    authorize(request: IncomingMessage, response: ServerResponse): boolean {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/desktop/authorize") return false;
      assert.equal(request.method, "GET");
      assert.equal(url.searchParams.get("client_id"), "zcode-desktop");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      assert.equal(redirect.protocol, "http:");
      assert.equal(redirect.hostname, "127.0.0.1");
      assert.equal(redirect.pathname, "/callback");
      const code = randomBytes(32).toString("base64url");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge")!,
        redirect: redirect.toString(),
        user: selectedUser(),
      });
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      response.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" });
      response.end();
      return true;
    },
    exchange(body: Record<string, unknown>): number | null {
      const entry = codes.get(String(body.code));
      codes.delete(String(body.code));
      if (!entry || entry.redirect !== body.redirect_uri || typeof body.code_verifier !== "string")
        return null;
      if (createHash("sha256").update(body.code_verifier).digest("base64url") !== entry.challenge)
        return null;
      return entry.user;
    },
  };
}

/** 不打开真实网站；系统外链端口改为访问本地合成授权页，其余产品链路保持真实。 */
export async function installBrowserAuthorizationFixture(app: ElectronApplication, origin: string) {
  await app.evaluate(({ shell }, allowedOrigin) => {
    shell.openExternal = async (value: string) => {
      const url = new URL(value);
      if (url.origin !== allowedOrigin || url.pathname !== "/desktop/authorize") return;
      const response = await fetch(value);
      if (!response.ok) throw new Error("Local browser authorization failed");
    };
  }, origin);
}
