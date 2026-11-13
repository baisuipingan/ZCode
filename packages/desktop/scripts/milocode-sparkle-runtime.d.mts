export const SPARKLE_VERSION: string;
export const SPARKLE_ARCHIVE_SHA256: string;
export const SPARKLE_ARCHIVE_URL: string;
/** Sparkle owns the native update transaction. Main owns permission to quit. */
export type MiloCodeSparkleEventKind =
  | "checking"
  | "update-available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "install-request"
  | "installing"
  | "error"
  | "idle";
export interface MiloCodeSparkleEvent {
  readonly kind: MiloCodeSparkleEventKind;
  /** Target bundle version, never the currently running application version. */
  readonly version?: string;
  /** Native transaction token. Only the matching pending token may be approved. */
  readonly requestId?: string;
  readonly message?: string;
}
/** Load only the packaged addon, then call it on Electron's Cocoa main thread. */
export interface MiloCodeSparkleNativeBridge {
  start(callback: (event: MiloCodeSparkleEvent) => void): void;
  checkForUpdates(): void;
  /** Approval is valid only after the existing Host/Agent quit preparation finishes. */
  resolveInstall(requestId: string, allow: boolean): void;
  dispose(): void;
}
export interface SparkleDistribution {
  version: string;
  distributionDir: string;
  frameworkPath: string;
  binDir: string;
  licensePath: string;
}
export function verifySparkleArchive(path: string): Promise<void>;
export function ensureSparkleDistribution(options?: {
  cacheDir?: string;
}): Promise<SparkleDistribution>;
export function prepareMacSparkleRuntime(options?: {
  outDir?: string;
  targetArch?: string;
  nodeIncludeDir?: string;
  cacheDir?: string;
  engineeringTest?: boolean;
}): Promise<SparkleDistribution & { nativePath: string; outDir: string }>;
