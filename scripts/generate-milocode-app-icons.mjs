import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// PNG 编解码复用桌面已有 ICNS 工具的依赖，不增加应用运行时依赖。
const desktopRequire = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const { PNG } = createRequire(desktopRequire.resolve("@fiahfy/icns"))("pngjs");
const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, "packages/desktop/build");
const windowsSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const macEntries = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];
const hash = (data) => createHash("sha256").update(data).digest("hex");

function cropWordmark(source) {
  const rgba = PNG.sync.read(source);
  let left = rgba.width,
    top = rgba.height,
    right = -1,
    bottom = -1;
  // 原素材实际为 PNG，按白底合成后取字标边界，不重绘字形或颜色。
  for (let y = 0; y < rgba.height; y++) {
    for (let x = 0; x < rgba.width; x++) {
      const i = (y * rgba.width + x) * 4;
      const alpha = rgba.data[i + 3] / 255;
      for (let c = 0; c < 3; c++)
        rgba.data[i + c] = Math.round(rgba.data[i + c] * alpha + 255 * (1 - alpha));
      rgba.data[i + 3] = 255;
      if (Math.min(...rgba.data.subarray(i, i + 3)) < 245) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left || bottom < top) throw new Error("Wordmark source is empty");
  const cropped = new PNG({ width: right - left + 1, height: bottom - top + 1 });
  PNG.bitblt(rgba, cropped, left, top, cropped.width, cropped.height, 0, 0);
  return cropped;
}

function whitePlate(width, radius) {
  const image = new PNG({ width: 1024, height: 1024 });
  const inset = (1024 - width) / 2;
  const halfStraight = width / 2 - radius;
  // 只让背板外围透明，保留用户指定的纯白色背板；不能再次铺满整个画布。
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      let inside = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4,
            py = y + (sy + 0.5) / 4;
          if (px < inset || py < inset || px >= 1024 - inset || py >= 1024 - inset) continue;
          const dx = Math.max(Math.abs(px - 512) - halfStraight, 0);
          const dy = Math.max(Math.abs(py - 512) - halfStraight, 0);
          if (dx * dx + dy * dy <= radius * radius) inside++;
        }
      }
      const i = (y * 1024 + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
      image.data[i + 3] = Math.round((inside * 255) / 16);
    }
  }
  return image;
}

function encodeIco(images) {
  const blobs = windowsSizes.map((size) => {
    if (size === 256) return images.get(size);
    const rgba = PNG.sync.read(images.get(size)).data;
    const maskStride = Math.ceil(size / 32) * 4;
    const xorBytes = size * size * 4;
    const dib = Buffer.alloc(40 + xorBytes + maskStride * size);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(size, 4);
    dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    dib.writeUInt32LE(xorBytes, 20);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4;
        const row = size - 1 - y,
          d = 40 + (row * size + x) * 4;
        dib[d] = rgba[s + 2];
        dib[d + 1] = rgba[s + 1];
        dib[d + 2] = rgba[s];
        dib[d + 3] = rgba[s + 3];
        // 小尺寸 DIB 也必须保留 alpha 和 AND mask，否则任务栏仍会出现实心白方块。
        if (rgba[s + 3] === 0)
          dib[40 + xorBytes + row * maskStride + Math.floor(x / 8)] |= 0x80 >> (x % 8);
      }
    }
    return dib;
  });
  const directory = Buffer.alloc(6 + 16 * blobs.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(blobs.length, 4);
  let offset = directory.length;
  windowsSizes.forEach((size, index) => {
    const at = 6 + index * 16;
    directory[at] = directory[at + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(blobs[index].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += blobs[index].length;
  });
  return Buffer.concat([directory, ...blobs]);
}

function encodeIcns(images) {
  const chunks = macEntries.map(([type, size]) => {
    const png = images.get(size),
      header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

async function resize(input, width, height, output) {
  await run("/usr/bin/sips", ["-z", String(height), String(width), input, "--out", output]);
  return readFile(output);
}

async function main() {
  if (process.platform !== "darwin")
    throw new Error("Generate icon resources on macOS (sips required)");
  const source = await readFile(join(build, "branding/milo-wordmark.png"));
  const wordmark = cropWordmark(source);
  const temporary = await mkdtemp(join(tmpdir(), "milocode-platform-icons-"));
  try {
    const croppedPath = join(temporary, "wordmark.png");
    await writeFile(croppedPath, PNG.sync.write(wordmark));
    const outputs = new Map();
    for (const [platform, plateWidth, radius, logoWidth, sizes] of [
      ["mac", 824, 184, 700, [...new Set(macEntries.map(([, size]) => size))]],
      ["win", 896, 160, 772, [...windowsSizes, 1024]],
    ]) {
      const plate = whitePlate(plateWidth, radius);
      const logoHeight = Math.round((wordmark.height * logoWidth) / wordmark.width);
      const logo = PNG.sync.read(
        await resize(croppedPath, logoWidth, logoHeight, join(temporary, `${platform}-logo.png`)),
      );
      PNG.bitblt(
        logo,
        plate,
        0,
        0,
        logoWidth,
        logoHeight,
        (1024 - logoWidth) / 2,
        Math.round((1024 - logoHeight) / 2),
      );
      const master = PNG.sync.write(plate);
      const masterPath = join(temporary, `${platform}.png`);
      await writeFile(masterPath, master);
      const images = new Map();
      for (const size of sizes)
        images.set(
          size,
          size === 1024
            ? master
            : await resize(masterPath, size, size, join(temporary, `${platform}-${size}.png`)),
        );
      if (platform === "mac") {
        outputs.set("icon_mac.png", master);
        const icns = encodeIcns(images);
        outputs.set("icon.icns", icns);
        outputs.set("icon_installer.icns", icns);
      } else {
        outputs.set("icon_windows.png", master);
        const ico = encodeIco(images);
        outputs.set("icon.ico", ico);
        outputs.set("icon_installer.ico", ico);
      }
    }
    if (process.argv.includes("--check")) {
      for (const [name, content] of outputs)
        if (!(await readFile(join(build, name))).equals(content))
          throw new Error(`Stale icon asset: ${name}`);
    } else {
      for (const [name, content] of outputs) await writeFile(join(build, name), content);
    }
    console.log(
      JSON.stringify(
        {
          mode: process.argv.includes("--check") ? "check" : "write",
          sourceSha256: hash(source),
          files: [...outputs].map(([name, data]) => ({
            name,
            bytes: data.length,
            sha256: hash(data),
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
