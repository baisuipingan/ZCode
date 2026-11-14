import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 复用 PDF 预览已有的图像依赖，不引入安装时或应用运行时的新依赖。
const canvasRequire = createRequire(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const { createCanvas, loadImage } = canvasRequire("@napi-rs/canvas");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, "packages/desktop/build");
const source = await readFile(
  join(build, "branding/milocode-dmg-background.svg"),
);
const image = await loadImage(source);
if (image.width !== 540 || image.height !== 380)
  throw new Error("DMG background must be 540×380");
const outputs = [];
for (const scale of [1, 2]) {
  const canvas = createCanvas(540 * scale, 380 * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const bytes = await canvas.encode("png");
  const name = scale === 1 ? "dmg_background.png" : "dmg_background@2x.png";
  // 旧背景的 ZCODE 是图片像素，修改应用图标或文本替换无法修复；两种倍率必须同源重建。
  if (process.argv.includes("--check")) {
    if (!(await readFile(join(build, name))).equals(bytes))
      throw new Error(`Stale DMG background: ${name}`);
  } else {
    await writeFile(join(build, name), bytes);
  }
  outputs.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
console.log(
  JSON.stringify(
    {
      mode: process.argv.includes("--check") ? "check" : "write",
      files: outputs,
    },
    null,
    2,
  ),
);
