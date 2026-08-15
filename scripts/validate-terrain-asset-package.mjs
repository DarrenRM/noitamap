import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import JSZip from "jszip";

const ROOT = resolve(import.meta.dirname, "..");
const ARCHIVE = resolve(ROOT, "public/terrain-assets.zip");
const GENERATED_IDENTITY = resolve(ROOT, "src/terrain/generated-asset-package.ts");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

const archiveBytes = await readFile(ARCHIVE);
const archiveHash = sha256(archiveBytes);
const identitySource = await readFile(GENERATED_IDENTITY, "utf8");
const declaredArchiveHash = /TERRAIN_ASSET_PACKAGE_SHA256\s*=\s*"([0-9A-F]{64})"/.exec(identitySource)?.[1];
if (declaredArchiveHash !== archiveHash) {
  throw new Error(`Generated terrain package identity is stale: ${declaredArchiveHash ?? "missing"} != ${archiveHash}`);
}
const zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true });
const manifestFile = zip.file("terrain/manifest.json");
if (!manifestFile) throw new Error("terrain/manifest.json is missing");
const manifest = JSON.parse(await manifestFile.async("string"));
const declared = new Set(["terrain/manifest.json"]);

for (const entry of manifest.entries) {
  if (declared.has(entry.path)) throw new Error(`Duplicate manifest path: ${entry.path}`);
  declared.add(entry.path);
  const file = zip.file(entry.path);
  if (!file) throw new Error(`Declared asset is missing: ${entry.path}`);
  const bytes = await file.async("uint8array");
  if (bytes.byteLength !== entry.bytes) {
    throw new Error(`Length mismatch for ${entry.path}: ${bytes.byteLength} != ${entry.bytes}`);
  }
  const actualHash = sha256(bytes);
  if (actualHash !== entry.sha256) {
    throw new Error(`SHA-256 mismatch for ${entry.path}: ${actualHash} != ${entry.sha256}`);
  }
}

const undeclared = Object.keys(zip.files).filter((path) => !zip.files[path].dir && !declared.has(path));
if (undeclared.length) throw new Error(`Archive contains undeclared assets: ${undeclared.join(", ")}`);
console.log(JSON.stringify({
  archive: "public/terrain-assets.zip",
  bytes: archiveBytes.byteLength,
  sha256: archiveHash,
  declaredEntries: manifest.entries.length,
  undeclaredEntries: 0,
}, null, 2));
