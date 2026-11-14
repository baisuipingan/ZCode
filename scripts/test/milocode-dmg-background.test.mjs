import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const desktopRequire = createRequire(
  new URL("../../packages/desktop/package.json", import.meta.url),
);
const { PNG } = createRequire(desktopRequire.resolve("@fiahfy/icns"))("pngjs");
const build = new URL("../../packages/desktop/build/", import.meta.url);

test("DMG branding is outlined and does not depend on fonts or old ZCode pixels", async () => {
  const source = await readFile(
    new URL("branding/milocode-dmg-background.svg", build),
    "utf8",
  );
  assert.match(source, /<title>MiloCode<\/title>/);
  assert.match(source, /Drag MiloCode to Applications/);
  assert.doesNotMatch(source, /<text\b|zcode|ZCODE|href=|<image\b/);
  assert.match(source, /width="540" height="380"/);
});

for (const [name, scale] of [
  ["dmg_background.png", 1],
  ["dmg_background@2x.png", 2],
]) {
  test(`${name} is opaque, correctly sized and leaves Finder icon positions clear`, async () => {
    const image = PNG.sync.read(await readFile(new URL(name, build)));
    assert.equal(image.width, 540 * scale);
    assert.equal(image.height, 380 * scale);
    for (let index = 3; index < image.data.length; index += 4)
      assert.equal(image.data[index], 255);
    const pixel = (x, y) => [
      ...image.data.subarray(
        (y * image.width + x) * 4,
        (y * image.width + x) * 4 + 4,
      ),
    ];
    const background = pixel(0, 0);
    for (const center of [130, 410]) {
      for (let y = 160 * scale; y <= 280 * scale; y++) {
        for (let x = (center - 60) * scale; x <= (center + 60) * scale; x++) {
          assert.deepEqual(
            pixel(x, y),
            background,
            `Finder icon/label area is clear at ${x},${y}`,
          );
        }
      }
    }
    assert.notDeepEqual(
      pixel(270 * scale, 220 * scale),
      background,
      "visible centered drag arrow",
    );
  });
}
