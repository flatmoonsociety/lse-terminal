// Assemble the three native build artifacts for one GitHub release.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const yaml = require("js-yaml");

async function prepareRelease(input, output, tag) {
  const groups = ["mac-x64", "mac-arm64", "windows-x64"];
  // GitHub normalizes spaces in asset names to dots during upload.
  const assetName = name => name.replace(/ /g, ".");
  const assets = new Map();
  for (const group of groups) {
    for (const entry of fs.readdirSync(path.join(input, group), { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(`Unexpected asset directory: ${group}/${entry.name}`);
      const name = assetName(entry.name);
      if (assets.has(name)) throw new Error(`Duplicate release asset: ${name}`);
      assets.set(name, path.join(input, group, entry.name));
    }
  }
  const readMetadata = name => {
    const info = yaml.load(fs.readFileSync(assets.get(name), "utf8"));
    if (`v${info.version}` !== tag) throw new Error(`${name}: version does not match ${tag}`);
    if (!Array.isArray(info.files) || info.files.length === 0) throw new Error(`${name}: no update files`);
    for (const file of info.files) {
      file.url = assetName(decodeURIComponent(file.url));
      if (!assets.has(file.url)) throw new Error(`${name}: missing asset ${file.url}`);
    }
    if (info.path) info.path = assetName(decodeURIComponent(info.path));
    return info;
  };
  const intel = readMetadata("latest-mac-x64.yml");
  const arm = readMetadata("latest-mac.yml");
  const windows = readMetadata("latest.yml");
  const merged = { ...intel, files: [...intel.files, ...arm.files] };
  if (new Set(merged.files.map(file => file.url)).size !== merged.files.length) {
    throw new Error("Duplicate macOS update file");
  }

  fs.mkdirSync(output, { recursive: true });
  if (fs.readdirSync(output).length) throw new Error("Release output directory must be empty");
  for (const [name, source] of assets) fs.copyFileSync(source, path.join(output, name));
  // The updater selects arm64 files on Apple Silicon and excludes them on Intel.
  // Keep Intel's legacy path/sha512 fields for older clients.
  fs.writeFileSync(path.join(output, "latest-mac.yml"), yaml.dump(merged, { lineWidth: -1 }));
  fs.writeFileSync(path.join(output, "latest-mac-x64.yml"), yaml.dump(intel, { lineWidth: -1 }));
  fs.writeFileSync(path.join(output, "latest.yml"), yaml.dump(windows, { lineWidth: -1 }));
  const checksums = [];
  for (const name of [...assets.keys()].sort()) {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(path.join(output, name))) hash.update(chunk);
    checksums.push(`${hash.digest("hex")}  ${name}\n`);
  }
  fs.writeFileSync(path.join(output, "SHA256SUMS.txt"), checksums.join(""));
}

module.exports = { prepareRelease };
if (require.main === module) {
  prepareRelease(...process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
