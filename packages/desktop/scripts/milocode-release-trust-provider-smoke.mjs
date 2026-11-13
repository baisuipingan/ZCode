import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

// 工程冒烟只验证真实 Electron 网络与签名 Provider，不下载或运行安装包。
const desktopDir = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(desktopDir, "package.json"));
const artifactRoot = resolve(desktopDir, ".e2e-artifacts");
await mkdir(artifactRoot, { recursive: true });
const root = await mkdtemp(resolve(artifactRoot, "milocode-release-trust-"));
const entry = resolve(root, "main.cjs");
const resultPath = resolve(root, "result.json");
await build({
  stdin: {
    resolveDir: desktopDir,
    sourcefile: "milocode-release-trust-network-fixture.mjs",
    contents: `
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { app, session } from 'electron';
import { MiloCodeSignedUpdateProvider } from './src/main/milocode-update-trust/index.ts';

app.setPath('userData', ${JSON.stringify(resolve(root, "user-data"))});
app.setPath('sessionData', ${JSON.stringify(resolve(root, "session-data"))});
const requests = [];
const key = generateKeyPairSync('ed25519');
const bytes = Buffer.from('fixture, never executable');
let server;
const results = [];
(async () => {
  await app.whenReady();
  server = createServer((request, response) => {
    requests.push({url: request.url, cookie: request.headers.cookie ?? null, auth: request.headers.authorization ?? null});
    const mode = request.url.split('/').pop();
    if (mode === 'redirect') { response.writeHead(302, {Location: base + 'should-not-fetch'}); response.end(); return; }
    if (mode === 'status') { response.writeHead(503); response.end(); return; }
    if (mode === 'declared-large') { response.writeHead(200, {'Content-Length': String(256 * 1024 + 1)}); response.end(); return; }
    if (mode === 'stream-large') { response.writeHead(200); response.write(' '.repeat(256 * 1024)); response.end('x'); return; }
    if (mode === 'utf8') { response.end(Buffer.from([255])); return; }
    if (mode === 'tampered') { response.end(JSON.stringify({...JSON.parse(raw), payload: Buffer.from('{}').toString('base64')})); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(raw);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port + '/milocode/';
  const payload = {schemaVersion:1,productId:'app.milo.code',platform:'win32-x64',channel:'stable',version:'3.17.3',releaseDate:'2026-11-13T00:00:00.000Z',files:[{url:base+'3.17.3/MiloCode.exe',size:bytes.length,sha512:createHash('sha512').update(bytes).digest('base64')}]};
  const data = Buffer.from(JSON.stringify(payload));
  const raw = JSON.stringify({schemaVersion:1,keyId:'engineering-test',payload:data.toString('base64'),signature:sign(null,data,key.privateKey).toString('base64')});
  const policy = {manifestUrl:base+'valid',releaseBaseUrl:base,publicKeys:{'engineering-test':key.publicKey.export({type:'spki',format:'pem'})},productId:'app.milo.code',platform:'win32-x64',allowInsecureLocalhost:true};
  const provider = mode => new MiloCodeSignedUpdateProvider({provider:'custom',miloCodePolicy:{...policy,manifestUrl:base+mode}}, {}, {isUseMultipleRangeRequest:false, platform:'win32',executor:{}});
  await session.defaultSession.cookies.set({url:base,name:'secret-session',value:'must-not-be-sent'});
  const active = provider('valid');
  const info = await active.getLatestVersion();
  assert.equal(info.version, '3.17.3');
  assert.equal(info.zcodeReleaseChannel, 'stable');
  assert.equal(info.milocodeSignedEnvelope, raw);
  assert.equal(active.resolveFiles(info)[0].url.href, payload.files[0].url);
  assert.throws(() => active.resolveFiles({...info,version:'3.17.4'}), /target changed/);
  results.push('valid signed feed and frozen version resolution');
  for (const mode of ['tampered','declared-large','stream-large','redirect','status','utf8']) {
    await assert.rejects(provider(mode).getLatestVersion());
    results.push(mode + ' rejected');
  }
  assert.equal(requests.some(request => request.url.endsWith('should-not-fetch')), false);
  assert.equal(requests.every(request => request.cookie === null && request.auth === null), true);
  results.push('no redirects, login cookies or authorization headers');
  const original = Object.getOwnPropertyDescriptor(app, 'isPackaged');
  Object.defineProperty(app, 'isPackaged', {value:true, configurable:true});
  assert.throws(() => provider('valid'), /Packaged MiloCode/);
  if (original) Object.defineProperty(app, 'isPackaged', original);
  results.push('packaged insecure localhost rejected');
  await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({passed:results.length,results,requests},null,2));
  server.close(() => app.exit(0));
})().catch(async error => {
  await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({error:error.stack,results,requests},null,2));
  server?.close();
  app.exit(1);
});
`,
  },
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "electron-updater"],
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  await promisify(execFile)(require("electron"), [entry], {
    env,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
} catch (error) {
  await writeFile(resolve(root, "process-error.txt"), String(error));
  throw new Error(`MiloCode release trust Electron smoke failed; evidence: ${root}`, {
    cause: error,
  });
}
const result = JSON.parse(await readFile(resultPath, "utf8"));
assert.equal(result.passed, 9);
console.log(`MiloCode release trust Electron smoke: ${result.passed}/9 passed; ${root}`);
