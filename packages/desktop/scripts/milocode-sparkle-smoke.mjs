#!/usr/bin/env node
// 真正的 Sparkle 两跳安装验证：独立 Electron .app、用户数据和临时测试密钥。
// 不覆盖 /Applications/MiloCode.app，不访问生产站点，不向钥匙串写测试私钥。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareMacSparkleRuntime } from "./milocode-sparkle-runtime.mjs";

const exec = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(desktopRoot, "../..");

export async function runMacSparkleSmoke({ keepArtifacts = false } = {}) {
  if (process.platform !== "darwin") throw new Error("Sparkle smoke requires macOS");
  const cacheRoot = join(workspaceRoot, ".cache/milocode-sparkle");
  await mkdir(cacheRoot, { recursive: true });
  const root = await mkdtemp(join(cacheRoot, "smoke-"));
  const eventsPath = join(root, "events.jsonl");
  const evidencePath = join(root, "result.json");
  const applications = join(root, "Applications");
  const sourceRoot = join(root, "sources");
  const archivesRoot = join(root, "archives");
  const userData = join(root, "user-data");
  const appName = "MiloUpdateSmoke.app";
  const installedApp = join(applications, appName);
  const bundleId = `app.milo.update-smoke.${process.pid}`;
  const running = new Set();
  let succeeded = false;
  let currentFeed = "";
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/appcast.xml") {
      const content = await readFile(currentFeed);
      response.writeHead(200, {
        "content-type": "application/xml",
        "cache-control": "no-store",
      });
      response.end(content);
    } else if (/^\/releases\/MiloUpdateSmoke-1\.0\.[12]\.zip$/.test(path)) {
      response.writeHead(200, { "content-type": "application/zip" });
      createReadStream(join(archivesRoot, path.split("/").at(-1))).pipe(response);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const runtime = await prepareMacSparkleRuntime({
      outDir: join(root, "runtime"),
      engineeringTest: true,
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateJwk = privateKey.export({ format: "jwk" });
    const publicJwk = publicKey.export({ format: "jwk" });
    const keyFile = join(root, "test-private-key");
    await writeFile(keyFile, Buffer.from(privateJwk.d, "base64url").toString("base64"), {
      mode: 0o600,
    });
    const publicBase64 = Buffer.from(publicJwk.x, "base64url").toString("base64");
    await Promise.all(
      [applications, sourceRoot, archivesRoot, userData].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    await writeFile(join(userData, "preserved.txt"), "keep-user-data");

    // 使用独立 bundle 身份；测试 driver 仅存在工程构建的 .node 中，正式桥不导出此函数。
    const mainSource = `
      const { app } = require('electron');
      const fs = require('node:fs');
      app.setPath('userData', ${JSON.stringify(userData)});
      const log = event => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({version: app.getVersion(), pid: process.pid, ...event})+'\\n');
      let prepared = false;
      app.on('before-quit', event => {
        if (app.getVersion() !== '1.0.2' && !prepared) {
          event.preventDefault(); log({kind:'quit-blocked-before-prepare'});
        }
      });
      app.whenReady().then(() => {
        log({kind:'launched'});
        if (app.getVersion() === '1.0.2') {
          log({kind:'completed', preserved:fs.readFileSync(${JSON.stringify(join(userData, "preserved.txt"))},'utf8')});
          setTimeout(()=>app.quit(), 300); return;
        }
        const bridge = require(require('node:path').join(process.resourcesPath,'milocode-update/milocode_sparkle.node'));
        let rejected = false;
        bridge.start(event => {
          log(event);
          if (event.kind === 'install-request') {
            if (!rejected) {
              rejected = true; bridge.resolveInstall(event.requestId, false);
              log({kind:'confirmation-cancelled'});
              setTimeout(()=>bridge.checkForUpdates(), 250);
            } else {
              setTimeout(()=>{
                prepared = true; log({kind:'quit-prepared'});
                bridge.resolveInstall(event.requestId, true);
              }, 200);
            }
          }
        });
        const timer = setInterval(()=>bridge.testClickDefaultButton(), 200);
        app.on('will-quit',()=>clearInterval(timer));
        setTimeout(()=>bridge.checkForUpdates(), app.getVersion() === '1.0.1' ? 750 : 0);
      }).catch(error=>{log({kind:'fixture-error',message:error.stack});app.exit(1)});
    `;
    for (const version of ["1.0.0", "1.0.1", "1.0.2"]) {
      const target = join(sourceRoot, version, appName);
      await mkdir(dirname(target), { recursive: true });
      // APFS clone 保留权限和 symlink，避免为三份 Electron 占用几 GB 独立磁盘空间。
      await exec("cp", [
        "-cR",
        join(workspaceRoot, "node_modules/electron/dist/Electron.app"),
        target,
      ]);
      const resources = join(target, "Contents/Resources");
      const appRoot = join(resources, "app");
      await mkdir(appRoot, { recursive: true });
      await writeFile(
        join(appRoot, "package.json"),
        JSON.stringify({
          name: "milocode-update-smoke",
          version,
          main: "index.cjs",
        }),
      );
      await writeFile(join(appRoot, "index.cjs"), mainSource);
      await mkdir(join(resources, "milocode-update"), { recursive: true });
      await cp(runtime.nativePath, join(resources, "milocode-update/milocode_sparkle.node"));
      await cp(runtime.frameworkPath, join(target, "Contents/Frameworks/Sparkle.framework"), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      const plist = join(target, "Contents/Info.plist");
      const values = {
        CFBundleIdentifier: bundleId,
        CFBundleName: "MiloUpdateSmoke",
        CFBundleDisplayName: "MiloUpdateSmoke",
        CFBundleVersion: version,
        CFBundleShortVersionString: version,
        SUFeedURL: `${origin}/appcast.xml`,
        SUPublicEDKey: publicBase64,
        MiloCodeReleaseBaseURL: `${origin}/`,
        SURequireSignedFeed: true,
        SUVerifyUpdateBeforeExtraction: true,
        SUSignedFeedFailureExpirationInterval: 0,
        SUEnableAutomaticChecks: false,
        SUAllowsAutomaticUpdates: false,
        SUAutomaticallyUpdate: false,
        MiloCodeUpdateTestFixture: true,
      };
      await exec("python3", [
        "-c",
        "import plistlib,json,sys; p=sys.argv[1]; d=plistlib.load(open(p,'rb'));d.update(json.loads(sys.argv[2]));d['NSAppTransportSecurity']={'NSAllowsLocalNetworking':True,'NSExceptionDomains':{'127.0.0.1':{'NSExceptionAllowsInsecureHTTPLoads':True}}};plistlib.dump(d,open(p,'wb'))",
        plist,
        JSON.stringify(values),
      ]);
      await exec("codesign", ["--force", "--deep", "--sign", "-", target]);
      if (version !== "1.0.0") {
        const archive = join(archivesRoot, `MiloUpdateSmoke-${version}.zip`);
        await exec("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", target, archive]);
        const { stdout } = await exec(join(runtime.binDir, "sign_update"), [
          "--ed-key-file",
          keyFile,
          archive,
        ]);
        const enclosureAttributes = stdout.trim();
        assert.match(enclosureAttributes, /sparkle:edSignature="/);
        const feedPath = join(archivesRoot, `appcast-${version}.xml`);
        await writeFile(
          feedPath,
          `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>MiloCode isolated updater verification</title><item><title>${version}</title><sparkle:version>${version}</sparkle:version><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><enclosure url="${origin}/releases/MiloUpdateSmoke-${version}.zip" ${enclosureAttributes} type="application/octet-stream"/></item></channel></rss>`,
        );
        await exec(join(runtime.binDir, "sign_update"), ["--ed-key-file", keyFile, feedPath]);
      }
    }
    await exec("cp", ["-cR", join(sourceRoot, "1.0.0", appName), installedApp]);
    currentFeed = join(archivesRoot, "appcast-1.0.1.xml");
    const launch = spawn(join(installedApp, "Contents/MacOS/Electron"), [], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    running.add(launch);
    launch.stderr.on("data", (data) => {
      void appendFile(join(root, "electron-stderr.log"), data);
    });
    const deadline = Date.now() + 120_000;
    let events = [];
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        events = (await readFile(eventsPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {}
      for (const event of events) if (event.pid) running.add(event.pid);
      const error = events.find((event) => ["fixture-error", "error"].includes(event.kind));
      if (error) throw new Error(`Sparkle smoke failed: ${error.message}`);
      if (events.some((event) => event.version === "1.0.1" && event.kind === "launched")) {
        currentFeed = join(archivesRoot, "appcast-1.0.2.xml");
      }
      if (events.some((event) => event.version === "1.0.2" && event.kind === "completed")) break;
    }
    for (const version of ["1.0.0", "1.0.1"]) {
      assert.ok(
        events.some(
          (event) => event.version === version && event.kind === "confirmation-cancelled",
        ),
        `${version}: cancel must be retryable`,
      );
      assert.ok(
        events.some((event) => event.version === version && event.kind === "quit-prepared"),
        `${version}: quit barrier must complete`,
      );
    }
    const completed = events.find(
      (event) => event.version === "1.0.2" && event.kind === "completed",
    );
    assert.equal(
      completed?.preserved,
      "keep-user-data",
      `two real upgrades must preserve fixture user data; events at ${eventsPath}`,
    );
    assert.equal(await readFile(join(userData, "preserved.txt"), "utf8"), "keep-user-data");
    const result = {
      passed: true,
      sparkle: runtime.version,
      versions: ["1.0.0", "1.0.1", "1.0.2"],
      cancelledAndRetriedEachHop: true,
      userDataPreserved: true,
      realMiloCodeModified: false,
    };
    await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    succeeded = true;
    return { ...result, root };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const processOrPid of running) {
      try {
        if (typeof processOrPid === "number") {
          process.kill(processOrPid, "SIGTERM");
        } else {
          processOrPid.kill("SIGTERM");
        }
      } catch {}
    }
    // 私钥无论成功或失败均移除，保留诊断输出不应留下测试签名材料。
    await rm(join(root, "test-private-key"), { force: true });
    if (!keepArtifacts && succeeded) {
      await Promise.all(
        ["sources", "Applications", "archives", "runtime"].map((name) =>
          rm(join(root, name), { recursive: true, force: true }),
        ),
      );
    }
    if (!succeeded) console.error(`[milocode-update] Sparkle smoke diagnostics: ${root}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(
    JSON.stringify(
      await runMacSparkleSmoke({
        keepArtifacts: process.argv.includes("--keep-artifacts"),
      }),
      null,
      2,
    ),
  );
}
