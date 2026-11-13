import { app, net } from "electron";
import type { CustomPublishOptions } from "builder-util-runtime";
import {
  Provider,
  type AppUpdater,
  type ResolvedUpdateFileInfo,
  type UpdateInfo,
} from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import {
  MILOCODE_RELEASE_MAX_MANIFEST_BYTES,
  validateMiloCodeUpdatePolicy,
  verifyMiloCodeRelease,
} from "../../../scripts/milocode-release-trust.mjs";
import type { MiloCodeSignedUpdateInfo, MiloCodeUpdateTrustPolicy } from "./contract.js";

export type { MiloCodeSignedUpdateInfo, MiloCodeUpdateTrustPolicy } from "./contract.js";
export {
  validateMiloCodeUpdatePolicy,
  verifyMiloCodeRelease,
  verifyMiloCodeUpdateArtifact,
} from "../../../scripts/milocode-release-trust.mjs";

export interface MiloCodeSignedUpdateProviderOptions extends CustomPublishOptions {
  miloCodePolicy: MiloCodeUpdateTrustPolicy;
}

function fetchSignedManifest(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      method: "GET",
      redirect: "error",
      useSessionCookies: false,
    });
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => fail(new Error("MiloCode update check timed out")), 20_000);
    timeout.unref();
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.abort();
      reject(error);
    }
    request.setHeader("Accept", "application/json");
    request.setHeader("Cache-Control", "no-cache");
    request.on("error", fail);
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`MiloCode update feed returned HTTP ${response.statusCode}`));
        return;
      }
      const length = response.headers["content-length"];
      const declaredLength = Number(Array.isArray(length) ? length[0] : length);
      if (Number.isFinite(declaredLength) && declaredLength > MILOCODE_RELEASE_MAX_MANIFEST_BYTES) {
        fail(new Error("MiloCode update feed is too large"));
        return;
      }
      response.on("error", fail);
      response.on("aborted", () => fail(new Error("MiloCode update feed was interrupted")));
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MILOCODE_RELEASE_MAX_MANIFEST_BYTES)
          fail(new Error("MiloCode update feed is too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        try {
          const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          settled = true;
          clearTimeout(timeout);
          resolve(raw);
        } catch {
          fail(new Error("MiloCode update feed is not UTF-8"));
        }
      });
    });
    request.end();
  });
}

/** 保留原生下载/差分机制，只在元数据边界增加 MiloCode 自有的发布授权。 */
export class MiloCodeSignedUpdateProvider extends Provider<UpdateInfo> {
  private readonly policy: MiloCodeUpdateTrustPolicy;

  constructor(
    options: CustomPublishOptions,
    _updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
    const policy = (options as Partial<MiloCodeSignedUpdateProviderOptions>).miloCodePolicy;
    if (!policy) throw new Error("MiloCode signed update policy is required");
    if (app.isPackaged && policy.allowInsecureLocalhost === true) {
      throw new Error("Packaged MiloCode cannot enable an insecure local update source");
    }
    validateMiloCodeUpdatePolicy(policy);
    this.policy = Object.freeze({
      ...policy,
      publicKeys: Object.freeze({ ...policy.publicKeys }),
    });
  }

  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  override async getLatestVersion(): Promise<MiloCodeSignedUpdateInfo> {
    const raw = await fetchSignedManifest(this.policy.manifestUrl);
    const payload = verifyMiloCodeRelease(raw, this.policy);
    return {
      version: payload.version,
      releaseDate: payload.releaseDate,
      releaseNotes: payload.releaseNotes,
      files: payload.files.map((file) => ({ ...file })),
      path: payload.files[0].url,
      sha512: payload.files[0].sha512,
      milocodeSignedEnvelope: raw,
      zcodeReleaseChannel: "stable",
    };
  }

  override resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    const envelope = (updateInfo as Partial<MiloCodeSignedUpdateInfo>).milocodeSignedEnvelope;
    if (typeof envelope !== "string")
      throw new Error("MiloCode update is missing its signed release context");
    const payload = verifyMiloCodeRelease(envelope, this.policy);
    if (payload.version !== updateInfo.version)
      throw new Error("MiloCode update target changed after verification");
    return payload.files.map((file) => ({
      url: new URL(file.url),
      info: { ...file },
    }));
  }
}
