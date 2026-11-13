#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createReleaseKeys } from "./milocode-release-keys.mjs";
import { prepareRelease, publishRelease } from "./milocode-release-stage.mjs";

const HELP = `MiloCode release tools (no paid distribution certificate required)

  node scripts/milocode-release.mjs keys --key-id NAME [--dir PRIVATE_DIRECTORY]
  node scripts/milocode-release.mjs prepare --config FILE --out NEW_DIRECTORY
  node scripts/milocode-release.mjs publish --dir PREPARED_DIRECTORY --dry-run
  node scripts/milocode-release.mjs publish --dir PREPARED_DIRECTORY

prepare writes a new local release tree. It never uploads or creates cloud resources.
publish --dry-run validates the tree without reading credentials or using the network.
publish uses MILOCODE_RELEASE_ADMIN_API_URL + exactly one of MILOCODE_RELEASE_ADMIN_TOKEN / MILOCODE_RELEASE_ADMIN_KEY, or direct S3 env configuration.
Administrator credentials are never sent to storage; version assets are immutable.
See docs/fork/31-client-update-release-guide.md for storage and key setup.
`;

function argumentsFor(values, allowed, boolean = []) {
  const result = {};
  for (let i = 0; i < values.length; i += 1) {
    const name = values[i];
    if (
      !name.startsWith("--") ||
      !allowed.includes(name.slice(2)) ||
      name.slice(2) in result
    ) {
      throw new Error(`Unknown or repeated release option: ${name}`);
    }
    if (boolean.includes(name.slice(2))) result[name.slice(2)] = true;
    else {
      const value = values[i + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${name}`);
      result[name.slice(2)] = value;
      i += 1;
    }
  }
  return result;
}

async function configFromFile(path) {
  const configPath = resolve(path);
  const body = await readFile(configPath, "utf8");
  if (body.length > 64 * 1024)
    throw new Error("Release configuration is too large");
  const config = JSON.parse(body);
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Invalid release configuration");
  const root = dirname(configPath);
  const local = (value) =>
    typeof value === "string" ? resolve(root, value) : undefined;
  return {
    version: config.version,
    baseUrl: config.baseUrl,
    releaseDate: config.releaseDate,
    releaseNotes: config.releaseNotesFile
      ? await readFile(local(config.releaseNotesFile), "utf8")
      : "",
    ...(config.windows
      ? {
          windows: {
            installer: local(config.windows.installer),
            blockmap: local(config.windows.blockmap),
            keyId: config.windows.keyId,
            privateKeyFile: local(config.windows.privateKeyFile),
          },
        }
      : {}),
    ...(config.mac
      ? {
          mac: {
            archive: local(config.mac.archive),
            dmg: local(config.mac.dmg),
            generateAppcast: local(config.mac.generateAppcast),
            account: config.mac.account,
            edKeyFile: local(config.mac.edKeyFile),
          },
        }
      : {}),
  };
}

export async function runReleaseCli(argv = process.argv.slice(2)) {
  const [command, ...values] = argv;
  if (!command || command === "--help" || command === "help")
    return { help: HELP };
  if (command === "keys") {
    const options = argumentsFor(values, ["key-id", "dir"]);
    return createReleaseKeys({ keyId: options["key-id"], keyDir: options.dir });
  }
  if (command === "prepare") {
    const options = argumentsFor(values, ["config", "out"]);
    if (!options.config || !options.out)
      throw new Error("prepare requires --config and --out");
    const plan = await prepareRelease({
      ...(await configFromFile(options.config)),
      outputDir: options.out,
    });
    return {
      prepared: true,
      version: plan.version,
      outputDir: resolve(options.out),
      objects: plan.objects.map(({ key, size, mutable }) => ({
        key,
        size,
        mutable,
      })),
    };
  }
  if (command === "publish") {
    const options = argumentsFor(values, ["dir", "dry-run"], ["dry-run"]);
    if (!options.dir) throw new Error("publish requires --dir");
    return publishRelease({
      dir: options.dir,
      dryRun: options["dry-run"] === true,
    });
  }
  throw new Error("Unknown release command; use --help");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runReleaseCli()
    .then((result) => {
      process.stdout.write(
        result.help ?? JSON.stringify(result, null, 2) + "\n",
      );
    })
    .catch((error) => {
      process.stderr.write(
        `MiloCode release failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
      process.exitCode = 1;
    });
}
