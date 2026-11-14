import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const desktopRequire = createRequire(
  new URL("../../packages/desktop/package.json", import.meta.url),
);
const iconRequire = createRequire(desktopRequire.resolve("@fiahfy/icns"));
const { PNG } = iconRequire("pngjs");
const build = new URL("../../packages/desktop/build/", import.meta.url);
const windowsSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const icnsSizes = new Map([
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
]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function checkPlate(image, ratio, label) {
  const { width: size, height, data } = image;
  assert.equal(height, size, `${label}: square canvas`);
  const alpha = (x, y) => data[(y * size + x) * 4 + 3];
  for (const [x, y] of [
    [0, 0],
    [size - 1, 0],
    [0, size - 1],
    [size - 1, size - 1],
  ]) {
    assert.equal(alpha(x, y), 0, `${label}: transparent outer corner ${x},${y}`);
  }
  const center = Math.floor(size / 2);
  const opaque = Array.from({ length: size }, (_, x) => x).filter((x) => alpha(x, center) >= 128);
  assert.ok(opaque.length > 0, `${label}: opaque plate exists`);
  const left = opaque[0];
  const right = opaque.at(-1);
  assert.ok(
    Math.abs(right - left + 1 - size * ratio) <= 2,
    `${label}: plate width matches platform ratio`,
  );
  assert.ok(Math.abs(left - (size - 1 - right)) <= 1, `${label}: plate is centered`);
  for (let x = left + 2; x <= right - 2; x++) {
    assert.equal(alpha(x, center), 255, `${label}: plate interior stays opaque`);
  }
  if (size >= 64) {
    const offset = (Math.round(size * 0.2) * size + center) * 4;
    assert.deepEqual(
      [...data.subarray(offset, offset + 4)],
      [255, 255, 255, 255],
      `${label}: white backplate`,
    );
  }
}

async function readPng(name) {
  return PNG.sync.read(await readFile(new URL(name, build)));
}

function decodeIco(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1, "ICO type");
  const count = bytes.readUInt16LE(4);
  const frames = [];
  let expectedOffset = 6 + 16 * count;
  for (let index = 0; index < count; index++) {
    const directory = 6 + index * 16;
    const size = bytes[directory] || 256;
    assert.equal(bytes[directory + 1] || 256, size);
    const length = bytes.readUInt32LE(directory + 8);
    const offset = bytes.readUInt32LE(directory + 12);
    assert.equal(offset, expectedOffset, "ICO frames occupy exact nonoverlapping spans");
    assert.ok(offset + length <= bytes.length);
    expectedOffset += length;
    const body = bytes.subarray(offset, offset + length);
    if (body.subarray(0, 8).equals(pngSignature)) {
      const image = PNG.sync.read(body);
      assert.equal(image.width, size);
      assert.equal(image.height, size);
      frames.push(image);
      continue;
    }
    assert.equal(body.readUInt32LE(0), 40, "ICO DIB header");
    assert.equal(body.readInt32LE(4), size);
    assert.equal(body.readInt32LE(8), size * 2);
    assert.equal(body.readUInt16LE(12), 1);
    assert.equal(body.readUInt16LE(14), 32, "ICO preserves per-pixel alpha");
    assert.equal(body.readUInt32LE(16), 0, "uncompressed BGRA DIB");
    const maskStride = Math.ceil(size / 32) * 4;
    assert.equal(body.length, 40 + size * size * 4 + maskStride * size);
    const data = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const source = 40 + ((size - 1 - y) * size + x) * 4;
        const target = (y * size + x) * 4;
        data.set([body[source + 2], body[source + 1], body[source], body[source + 3]], target);
        const mask = body[40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3)];
        const transparent = (mask >> (7 - (x & 7))) & 1;
        // PNG 正确不代表小图正确：DIB 的 alpha 和 AND mask 也必须共同保留外围透明。
        assert.equal(
          transparent,
          body[source + 3] === 0 ? 1 : 0,
          `ICO ${size}: AND mask agrees with alpha at ${x},${y}`,
        );
      }
    }
    frames.push({ width: size, height: size, data });
  }
  assert.equal(expectedOffset, bytes.length, "ICO has no unparsed trailing bytes");
  return frames;
}

test("Mac runtime icon has a white plate with transparent safe area", async () => {
  const image = await readPng("icon_mac.png");
  assert.ok(image.width >= 512);
  checkPlate(image, 824 / 1024, "Mac runtime PNG");
});

for (const name of ["icon.icns", "icon_installer.icns"]) {
  test(`${name} preserves the Mac safe area in every ICNS frame`, async () => {
    const bytes = await readFile(new URL(name, build));
    assert.equal(bytes.toString("ascii", 0, 4), "icns");
    assert.equal(bytes.readUInt32BE(4), bytes.length);
    const seen = new Set();
    let offset = 8;
    while (offset < bytes.length) {
      const type = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32BE(offset + 4);
      assert.ok(length > 8 && offset + length <= bytes.length);
      assert.ok(icnsSizes.has(type), `recognized ICNS image frame ${type}`);
      assert.ok(!seen.has(type), `unique ICNS frame ${type}`);
      seen.add(type);
      const body = bytes.subarray(offset + 8, offset + length);
      assert.ok(body.subarray(0, 8).equals(pngSignature));
      const image = PNG.sync.read(body);
      assert.equal(image.width, icnsSizes.get(type));
      checkPlate(image, 824 / 1024, `${name}/${type}`);
      offset += length;
    }
    assert.equal(offset, bytes.length);
    assert.deepEqual([...seen].sort(), [...icnsSizes.keys()].sort());
  });
}

test("Windows runtime PNG uses its own more compact plate", async () => {
  const image = await readPng("icon_windows.png");
  assert.ok(image.width >= 256);
  checkPlate(image, 7 / 8, "Windows runtime PNG");
});

for (const name of ["icon.ico", "icon_installer.ico"]) {
  test(`${name} includes correctly transparent Windows frames and AND masks`, async () => {
    const frames = decodeIco(await readFile(new URL(name, build)));
    assert.deepEqual(
      frames.map((frame) => frame.width).sort((a, b) => a - b),
      windowsSizes,
    );
    for (const frame of frames) checkPlate(frame, 7 / 8, `${name}/${frame.width}`);
  });
}
