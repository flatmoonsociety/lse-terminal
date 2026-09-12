const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const yaml = require("js-yaml");
const { prepareRelease } = require("./prepare-release");

test("release assembly merges native mac updates, checksums every asset and rejects mismatches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lse-release-"));
  try {
    const groups = { "mac-x64": "latest-mac-x64.yml", "mac-arm64": "latest-mac.yml", "windows-x64": "latest.yml" };
    for (const [group, metadata] of Object.entries(groups)) {
      const folder = path.join(root, "in", group);
      fs.mkdirSync(folder, { recursive: true });
      const names = group.startsWith("mac") ? [`app-${group}.zip`, `app-${group}.dmg`] : ["app.exe"];
      const info = { version: "0.0.14", files: names.map(url => ({ url, sha512: `hash-${url}`, size: 7 })), path: names[0], sha512: "legacy" };
      for (const name of names) fs.writeFileSync(path.join(folder, name), "payload");
      fs.writeFileSync(path.join(folder, metadata), yaml.dump(info));
    }
    const input = path.join(root, "in");
    const output = path.join(root, "out");
    await prepareRelease(input, output, "v0.0.14");
    const merged = yaml.load(fs.readFileSync(path.join(output, "latest-mac.yml"), "utf8"));
    assert.deepEqual(merged.files.map(file => file.url), ["app-mac-x64.zip", "app-mac-x64.dmg", "app-mac-arm64.zip", "app-mac-arm64.dmg"]);
    assert.equal(merged.path, "app-mac-x64.zip");
    const lines = fs.readFileSync(path.join(output, "SHA256SUMS.txt"), "utf8").trim().split("\n");
    assert.equal(lines.length, fs.readdirSync(output).length - 1);
    for (const line of lines) {
      const [digest, name] = line.split("  ");
      assert.equal(digest, createHash("sha256").update(fs.readFileSync(path.join(output, name))).digest("hex"));
    }
    await assert.rejects(prepareRelease(input, path.join(root, "bad-version"), "v0.0.15"), /version does not match/);
    fs.writeFileSync(path.join(input, "mac-arm64", "app.exe"), "collision");
    await assert.rejects(prepareRelease(input, path.join(root, "duplicate"), "v0.0.14"), /Duplicate release asset/);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("lse-release-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
