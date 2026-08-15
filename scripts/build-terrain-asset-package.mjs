import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import JSZip from "jszip";
import { PNG } from "pngjs";

import { GENERATOR_CONFIG } from "../lib/noita-telescope/js/generator_config.js";
import { PIXEL_SCENE_BIOME_MAP } from "../lib/noita-telescope/js/pixel_scene_config.js";

const ROOT = resolve(import.meta.dirname, "..");
const WANG_ARCHIVE = resolve(ROOT, "public/wang_tiles.zip");
const DATA_ARCHIVE = resolve(ROOT, "public/data.zip");
const PIXEL_SCENE_ARCHIVE = resolve(ROOT, "public/pixel_scenes.zip");
const MATERIALS_FILE = resolve(ROOT, "public/assets/full_materials.json");
const OUTPUT_ARCHIVE = resolve(ROOT, "public/terrain-assets.zip");
const OUTPUT_MANIFEST = resolve(
  ROOT,
  "terrain/manifests/whole-map-terrain-assets.json",
);
const OUTPUT_IDENTITY = resolve(ROOT, "src/terrain/generated-asset-package.ts");
const FIXED_DATE = new Date("1980-01-01T00:00:00.000Z");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function archivePathFromWangFile(wangFile) {
  return wangFile.replace(/^\.\.\/data\/wang_tiles\//, "");
}

function biomeConfigPath(paths, biomeName) {
  const preferred = [
    `data/biome/${biomeName}.xml`,
    `data/biome/tower/${biomeName}.xml`,
    `data/biome_impl/static_tile/${biomeName}.xml`,
  ];
  return (
    preferred.find((path) => paths.has(path)) ??
    Array.from(paths).find((path) => path.endsWith(`/${biomeName}.xml`)) ??
    null
  );
}

function materialNamesFromXml(xml) {
  const names = new Set();
  for (const match of xml.matchAll(
    /<MaterialComponent\b[^>]*\bmaterial_name\s*=\s*"([^"]+)"/gi,
  )) {
    names.add(match[1]);
  }
  for (const match of xml.matchAll(/<VegetationComponent\b([^>]*)>/gi)) {
    for (const attribute of match[1].matchAll(
      /\b(?:tree_material|material_on_top_of)\s*=\s*"([^"]+)"/gi,
    )) {
      if (attribute[1]) names.add(attribute[1]);
    }
  }
  return names;
}

function edgeImagePathsFromMaterialsXml(xml) {
  return Array.from(
    new Set(
      Array.from(
        xml.matchAll(
          /\bfilename\s*=\s*"([^"]*materials_gfx\/edge_files\/[^"]+)"/gi,
        ),
        (match) => match[1],
      ),
    ),
  ).sort();
}

function materialRgb(material) {
  return typeof material.wang_color === "string" &&
    /^[0-9a-f]{8}$/i.test(material.wang_color)
    ? Number.parseInt(material.wang_color, 16) & 0xffffff
    : null;
}

function pixelSceneBiomeAlias(biomeName) {
  if (biomeName === "coalmine_alt") return "coalmine";
  if (biomeName === "excavationsite_cube_chamber") return "excavationsite";
  if (biomeName === "snowcave_secret_chamber") return "snowcave";
  if (
    ["sandcave", "snowcastle_cavern", "snowcastle_hourglass_chamber"].includes(
      biomeName,
    )
  )
    return "snowcastle";
  if (["rainforest_open", "rainforest_dark"].includes(biomeName))
    return "rainforest";
  if (biomeName === "vault_frozen") return "vault";
  if (["the_end", "the_sky"].includes(biomeName)) return "crypt";
  if (biomeName === "scale") return "overworld";
  if (biomeName.includes("temple")) return "temple";
  if (biomeName.includes("pyramid")) return "pyramid";
  if (biomeName.includes("mountain")) return "mountain";
  return biomeName;
}

const [wangBytes, dataBytes, pixelSceneBytes, materialBytes] =
  await Promise.all([
    readFile(WANG_ARCHIVE),
    readFile(DATA_ARCHIVE),
    readFile(PIXEL_SCENE_ARCHIVE),
    readFile(MATERIALS_FILE),
  ]);
const [wangZip, dataZip, pixelSceneZip] = await Promise.all([
  JSZip.loadAsync(wangBytes),
  JSZip.loadAsync(dataBytes),
  JSZip.loadAsync(pixelSceneBytes),
]);
const materials = JSON.parse(materialBytes.toString("utf8"));
const dataPaths = new Set(
  Object.keys(dataZip.files).filter((path) => !dataZip.files[path].dir),
);
const materialsXmlFile = dataZip.file("data/materials.xml");
if (!materialsXmlFile)
  throw new Error("Canonical data/materials.xml is missing from data.zip");
const materialsXmlBytes = await materialsXmlFile.async("uint8array");
const materialsXml = new TextDecoder().decode(materialsXmlBytes);
const activeMaterialsXml = materialsXml.replace(/<!--[\s\S]*?-->/g, "");
const edgeImagePaths = edgeImagePathsFromMaterialsXml(activeMaterialsXml);
const directEdgeGraphicsRecords = Array.from(
  activeMaterialsXml.matchAll(/<EdgeGraphics\b/g),
).length;
const directEdgeGraphicsImages = Array.from(
  activeMaterialsXml.matchAll(/<Image\b/g),
).length;

const biomeEntries = Object.entries(GENERATOR_CONFIG)
  // Telescope enables every configured route during initialization, including
  // the Lake route that generator_config disables only as a library default.
  // The standalone closure therefore follows authored Wang reachability, not
  // the mutable import-time enabled flag.
  .filter(([, config]) => config.wangFile)
  .sort(([left], [right]) => left.localeCompare(right));
const wangPaths = Array.from(
  new Set(
    biomeEntries.map(([, config]) => archivePathFromWangFile(config.wangFile)),
  ),
).sort();
const configurationBiomeNames = Array.from(
  new Set(biomeEntries.map(([biomeName]) => biomeName)),
).sort();
const packageEntries = [];
const packageBytes = new Map();
const directWangRgb = new Set();
const pixelSceneWangRgb = new Set();
const pixelSceneVariantMaterialNames = new Set();
const canonicalMaterialRgb = new Set(
  materials.map(materialRgb).filter((rgb) => rgb !== null),
);

for (const path of wangPaths) {
  const file = wangZip.file(path);
  if (!file)
    throw new Error(
      `Configured Wang sheet is missing from wang_tiles.zip: ${path}`,
    );
  const bytes = await file.async("nodebuffer");
  const image = PNG.sync.read(bytes);
  for (let offset = 0; offset + 3 < image.data.length; offset += 4) {
    const red = image.data[offset];
    const green = image.data[offset + 1];
    const blue = image.data[offset + 2];
    if ((red | green | blue) === 0 || (red === green && green === blue))
      continue;
    const rgb = (red << 16) | (green << 8) | blue;
    if (canonicalMaterialRgb.has(rgb)) directWangRgb.add(rgb);
  }
  packageEntries.push({
    path: `data/wang_tiles/${path}`,
    sourceArchive: "public/wang_tiles.zip",
    sourcePath: path,
    purpose: "seeded-wang-generation",
    authored: true,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
  packageBytes.set(`data/wang_tiles/${path}`, bytes);
}

// PixelScene material images enter the same Wang material pipeline as biome
// sheets. Close their direct colors and every seeded color_material target so
// the standalone appearance registry never depends on undeclared textures.
const pixelSceneMaterialPaths = new Set();
const missingPixelSceneMaterialPaths = [];
for (const [biomeName, groups] of Object.entries(PIXEL_SCENE_BIOME_MAP)) {
  const alias = pixelSceneBiomeAlias(biomeName);
  for (const scenes of Object.values(groups)) {
    for (const scene of scenes) {
      if (!scene?.name) continue;
      pixelSceneMaterialPaths.add(`${alias}/${scene.name}.png`);
      for (const names of Object.values(scene.color_material ?? {})) {
        for (const materialName of names)
          pixelSceneVariantMaterialNames.add(materialName);
      }
    }
  }
}
for (const path of Array.from(pixelSceneMaterialPaths).sort()) {
  const file = pixelSceneZip.file(path);
  if (!file) {
    missingPixelSceneMaterialPaths.push(path);
    continue;
  }
  const image = PNG.sync.read(await file.async("nodebuffer"));
  for (let offset = 0; offset + 3 < image.data.length; offset += 4) {
    const red = image.data[offset];
    const green = image.data[offset + 1];
    const blue = image.data[offset + 2];
    if ((red | green | blue) === 0 || (red === green && green === blue))
      continue;
    pixelSceneWangRgb.add((red << 16) | (green << 8) | blue);
  }
}

const configIndex = {};
const selectedMaterialNames = new Set();
for (const biomeName of configurationBiomeNames) {
  const path = biomeConfigPath(dataPaths, biomeName);
  if (!path)
    throw new Error(`Biome material configuration is missing: ${biomeName}`);
  const bytes = await dataZip.file(path).async("uint8array");
  const xml = new TextDecoder().decode(bytes);
  for (const name of materialNamesFromXml(xml)) selectedMaterialNames.add(name);
  configIndex[biomeName] = path;
  packageEntries.push({
    path,
    sourceArchive: "public/data.zip",
    sourcePath: path,
    purpose: "biome-material-selection",
    authored: true,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
  packageBytes.set(path, bytes);
}

const selectedMaterials = materials
  .filter(
    (material) =>
      selectedMaterialNames.has(material.id) ||
      pixelSceneVariantMaterialNames.has(material.id) ||
      directWangRgb.has(materialRgb(material)) ||
      pixelSceneWangRgb.has(materialRgb(material)) ||
      [5, 116, 158].includes(material.initial_id),
  )
  .sort((left, right) => left.initial_id - right.initial_id);
const unresolvedMaterialNames = Array.from(selectedMaterialNames)
  .filter((name) => !materials.some((material) => material.id === name))
  .sort();
if (unresolvedMaterialNames.length) {
  throw new Error(
    `Unresolved biome material names: ${unresolvedMaterialNames.join(", ")}`,
  );
}

const trimmedMaterials = new TextEncoder().encode(
  `${JSON.stringify(selectedMaterials)}\n`,
);
packageEntries.push({
  path: "terrain/materials.json",
  sourceArchive: "generated",
  sourcePath: "public/assets/full_materials.json",
  purpose: "canonical-material-definitions",
  authored: false,
  bytes: trimmedMaterials.byteLength,
  sha256: sha256(trimmedMaterials),
});
packageBytes.set("terrain/materials.json", trimmedMaterials);

packageEntries.push({
  path: "data/materials.xml",
  sourceArchive: "public/data.zip",
  sourcePath: "data/materials.xml",
  purpose: "authored-edge-graphics-definitions",
  authored: true,
  bytes: materialsXmlBytes.byteLength,
  sha256: sha256(materialsXmlBytes),
});
packageBytes.set("data/materials.xml", materialsXmlBytes);

for (const path of edgeImagePaths) {
  const file = dataZip.file(path);
  if (!file) throw new Error(`Authored EdgeGraphics image is missing: ${path}`);
  const bytes = await file.async("uint8array");
  packageEntries.push({
    path,
    sourceArchive: "public/data.zip",
    sourcePath: path,
    purpose: "authored-edge-graphics-image",
    authored: true,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
  packageBytes.set(path, bytes);
}

const texturePaths = Array.from(
  new Set(
    selectedMaterials
      .map((material) => material.graphics?.texture_file)
      .filter(Boolean),
  ),
).sort();
for (const path of texturePaths) {
  const file = dataZip.file(path);
  if (!file)
    throw new Error(`Selected authored material texture is missing: ${path}`);
  const bytes = await file.async("uint8array");
  packageEntries.push({
    path,
    sourceArchive: "public/data.zip",
    sourcePath: path,
    purpose: "authored-material-appearance",
    authored: true,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
  packageBytes.set(path, bytes);
}

const coreBiomePaths = [
  "data/biome_impl/biome_map.png",
  "data/biome_impl/biome_map_newgame_plus.png",
  "data/biome_impl/biome_map_nightmare.png",
  "data/biome_impl/biome_map_background.png",
  "data/biome_impl/biome_map_foreground.png",
];
for (const path of coreBiomePaths) {
  const file = dataZip.file(path);
  if (!file) {
    if (path.endsWith("biome_map_nightmare.png")) continue;
    throw new Error(`Core biome map is missing: ${path}`);
  }
  const bytes = await file.async("uint8array");
  packageEntries.push({
    path,
    sourceArchive: "public/data.zip",
    sourcePath: path,
    purpose: "seeded-biome-generation",
    authored: true,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
  packageBytes.set(path, bytes);
}

const configIndexBytes = new TextEncoder().encode(
  `${JSON.stringify(configIndex, null, 2)}\n`,
);
packageEntries.push({
  path: "terrain/biome-config-index.json",
  sourceArchive: "generated",
  sourcePath: "GENERATOR_CONFIG plus canonical data paths",
  purpose: "deterministic-biome-config-lookup",
  authored: false,
  bytes: configIndexBytes.byteLength,
  sha256: sha256(configIndexBytes),
});
packageBytes.set("terrain/biome-config-index.json", configIndexBytes);

packageEntries.sort((left, right) => left.path.localeCompare(right.path));
const manifest = {
  schemaVersion: 2,
  purpose:
    "Declared terrain-generation, generated grass-overlay, PixelScene material-stamping, and material-appearance content closure for the current whole-map routes.",
  scope: {
    wangSmoothingTypes: [0, 1, 2],
    note: "Package inclusion is closed; native smoothing types 1 and 2 and generalized type-0 surface generation remain implementation blockers.",
  },
  inputs: {
    wangArchive: {
      path: "public/wang_tiles.zip",
      bytes: wangBytes.byteLength,
      sha256: sha256(wangBytes),
    },
    dataArchive: {
      path: "public/data.zip",
      bytes: dataBytes.byteLength,
      sha256: sha256(dataBytes),
    },
    pixelSceneArchive: {
      path: "public/pixel_scenes.zip",
      bytes: pixelSceneBytes.byteLength,
      sha256: sha256(pixelSceneBytes),
    },
    materials: {
      path: "public/assets/full_materials.json",
      bytes: materialBytes.byteLength,
      sha256: sha256(materialBytes),
    },
  },
  totals: {
    biomeRoutes: biomeEntries.length,
    wangSheets: wangPaths.length,
    biomeConfigurations: configurationBiomeNames.length,
    materials: selectedMaterials.length,
    textures: texturePaths.length,
    pixelSceneMaterialImages: pixelSceneMaterialPaths.size,
    missingPixelSceneMaterialImages: missingPixelSceneMaterialPaths.length,
    pixelSceneDirectWangRgb: pixelSceneWangRgb.size,
    pixelSceneVariantMaterials: pixelSceneVariantMaterialNames.size,
    directEdgeGraphicsRecords,
    directEdgeGraphicsImages,
    edgeGraphicsAssets: edgeImagePaths.length,
    entries: packageEntries.length,
    uncompressedBytes: packageEntries.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    ),
  },
  entries: packageEntries,
  missingPixelSceneMaterialPaths,
};
const manifestBytes = new TextEncoder().encode(
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const output = new JSZip();
for (const entry of packageEntries) {
  output.file(entry.path, packageBytes.get(entry.path), {
    date: FIXED_DATE,
    createFolders: false,
  });
}
output.file("terrain/manifest.json", manifestBytes, {
  date: FIXED_DATE,
  createFolders: false,
});
const archiveBytes = await output.generateAsync({
  type: "uint8array",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
  platform: "DOS",
});
const archiveSha256 = sha256(archiveBytes);
const identityBytes = new TextEncoder().encode(
  `// Generated by scripts/build-terrain-asset-package.mjs. Do not edit by hand.\n` +
    `export const TERRAIN_ASSET_PACKAGE_SCHEMA_VERSION = ${manifest.schemaVersion};\n` +
    `export const TERRAIN_ASSET_PACKAGE_SHA256 = "${archiveSha256}";\n`,
);

await mkdir(dirname(OUTPUT_MANIFEST), { recursive: true });
await Promise.all([
  writeFile(OUTPUT_ARCHIVE, archiveBytes),
  writeFile(OUTPUT_MANIFEST, manifestBytes),
  writeFile(OUTPUT_IDENTITY, identityBytes),
]);
console.log(
  JSON.stringify(
    {
      archive: "public/terrain-assets.zip",
      archiveBytes: archiveBytes.byteLength,
      archiveSha256,
      manifest: "terrain/manifests/whole-map-terrain-assets.json",
      ...manifest.totals,
    },
    null,
    2,
  ),
);
