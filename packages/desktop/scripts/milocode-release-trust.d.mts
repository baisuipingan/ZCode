import type { KeyObject } from "node:crypto";

export interface MiloCodeUpdateTrustPolicy {
  readonly manifestUrl: string;
  readonly releaseBaseUrl: string;
  readonly publicKeys: Readonly<Record<string, string>>;
  readonly productId: "app.milo.code";
  readonly platform: "win32-x64";
  /** 仅未打包测试构建可以设置；正式策略只接受 HTTPS。 */
  readonly allowInsecureLocalhost?: boolean;
}

export interface MiloCodeReleaseFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

export interface MiloCodeReleasePayload {
  readonly schemaVersion: 1;
  readonly productId: "app.milo.code";
  readonly platform: "win32-x64";
  readonly channel: "stable";
  readonly version: string;
  readonly releaseDate: string;
  readonly releaseNotes?: string;
  readonly files: readonly [MiloCodeReleaseFile];
}

export const MILOCODE_RELEASE_SCHEMA_VERSION: 1;
export const MILOCODE_RELEASE_MAX_MANIFEST_BYTES: number;
export const MILOCODE_RELEASE_MAX_ARTIFACT_BYTES: number;
export function validateMiloCodeUpdatePolicy(
  policy: MiloCodeUpdateTrustPolicy,
): MiloCodeUpdateTrustPolicy;
export function signMiloCodeRelease(
  payload: MiloCodeReleasePayload,
  options: { keyId: string; privateKey: string | Buffer | KeyObject },
): string;
export function verifyMiloCodeRelease(
  rawEnvelope: string,
  policy: MiloCodeUpdateTrustPolicy,
): MiloCodeReleasePayload;
export function verifyMiloCodeUpdateArtifact(
  filePath: string,
  rawEnvelope: string,
  policy: MiloCodeUpdateTrustPolicy,
  options?: { expectedVersion?: string },
): Promise<MiloCodeReleasePayload>;
