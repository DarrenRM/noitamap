import { getZip } from "../data-archive";
import { decodePngToRgba } from "../telescope/png-decode";
import type { TileLayer } from "../telescope/telescope-adapter";
import {
  type CanonicalMaterialDefinition,
  type MaterialTexture,
  NativeMaterialAppearanceRegistry,
} from "./material-appearance";
import { parseBiomeMaterialsConfiguration } from "./biome-material-config";
import {
  parseDirectEdgeGraphicsInventory,
  type EdgeGraphicsInventory,
  type EdgeGraphicsStampImage,
} from "./edge-graphics";
import type { BiomeMaterialsConfiguration } from "./wang-type2";
import {
  parseBiomeVegetationConfiguration,
  type BiomeVegetationConfiguration,
} from "./vegetation";
import { TERRAIN_ASSET_PACKAGE_SHA256 } from "./generated-asset-package";
import { BIOME_SPAWN_FUNCTION_MAP } from "../../lib/noita-telescope/js/spawn_function_config.js";

export interface NativeMaterialAssetReport {
  packageSchemaVersion: number;
  packageSha256: string;
  packageDeclaredEntries: number;
  wangRgbCount: number;
  wangRgbContextCount: number;
  pixelSceneWangRgbCount: number;
  resolvedWangRgbCount: number;
  resolvedWangRgbContextCount: number;
  ambiguousWangRgb: number[];
  spawnMarkerRgb: number[];
  spawnMarkerRgbContextCount: number;
  scalarFallbackRgb: number[];
  scalarFallbackRgbContextCount: number;
  materialIds: string[];
  texturePaths: string[];
  edgeGraphicsDirectRecords: number;
  edgeGraphicsDirectImages: number;
  edgeGraphicsEffectiveRecords: number;
  edgeGraphicsEffectiveImages: number;
  edgeGraphicsAssetPaths: string[];
  biomeConfigurationPaths: string[];
  missingBiomeConfigurations: string[];
  unresolvedBiomeMaterialNames: string[];
  vegetationComponentCount: number;
  grassComponentCount: number;
  unresolvedVegetationMaterialNames: string[];
}

export interface LoadedNativeMaterialAssets {
  registry: NativeMaterialAppearanceRegistry;
  biomeMaterials: ReadonlyMap<string, BiomeMaterialsConfiguration>;
  biomeVegetation: ReadonlyMap<string, BiomeVegetationConfiguration>;
  edgeGraphics: EdgeGraphicsInventory;
  edgeGraphicsImages: ReadonlyMap<string, EdgeGraphicsStampImage>;
  report: NativeMaterialAssetReport;
}

let materialDefinitionsPromise: Promise<CanonicalMaterialDefinition[]> | null = null;
const decodedTextures = new Map<string, MaterialTexture>();

export async function loadCanonicalMaterialDefinitions(): Promise<CanonicalMaterialDefinition[]> {
  if (!materialDefinitionsPromise) {
    materialDefinitionsPromise = getZip("terrain").then(async (zip) => {
      const file = zip?.file("terrain/materials.json");
      if (!file) throw new Error("[NativeMaterialAssets] terrain/materials.json is missing from terrain-assets.zip");
      return JSON.parse(await file.async("string")) as CanonicalMaterialDefinition[];
    });
  }
  return materialDefinitionsPromise;
}

export function collectNonGrayWangRgb(tileLayers: readonly TileLayer[]): Set<number> {
  const colors = new Set<number>();
  for (const layer of tileLayers) {
    const buffer = layer.buffer;
    if (!buffer) continue;
    for (let offset = 0; offset + 2 < buffer.length; offset += 3) {
      const red = buffer[offset];
      const green = buffer[offset + 1];
      const blue = buffer[offset + 2];
      if ((red | green | blue) === 0 || (red === green && green === blue)) continue;
      colors.add((red << 16) | (green << 8) | blue);
    }
  }
  return colors;
}

function collectNonGrayWangRgbByBiome(tileLayers: readonly TileLayer[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const layer of tileLayers) {
    const colors = result.get(layer.biomeName) ?? new Set<number>();
    const buffer = layer.buffer;
    if (!buffer) continue;
    for (let offset = 0; offset + 2 < buffer.length; offset += 3) {
      const red = buffer[offset];
      const green = buffer[offset + 1];
      const blue = buffer[offset + 2];
      if ((red | green | blue) === 0 || (red === green && green === blue)) continue;
      colors.add((red << 16) | (green << 8) | blue);
    }
    result.set(layer.biomeName, colors);
  }
  return result;
}

function isKnownSpawnMarker(biomeName: string, rgb: number): boolean {
  const definitions = (BIOME_SPAWN_FUNCTION_MAP as Record<string, Array<{ color: number }>>)[biomeName];
  return !!definitions?.some((definition) => definition.color === rgb);
}

export async function loadNativeMaterialAssetsForLayers(
  tileLayers: readonly TileLayer[],
  pixelSceneWangRgb: ReadonlySet<number> = new Set(),
): Promise<LoadedNativeMaterialAssets> {
  const materials = await loadCanonicalMaterialDefinitions();
  const byWangRgb = new Map<number, CanonicalMaterialDefinition[]>();
  for (const material of materials) {
    if (!material.wang_color || !/^[0-9a-f]{8}$/i.test(material.wang_color)) continue;
    const rgb = Number.parseInt(material.wang_color, 16) & 0xffffff;
    const matches = byWangRgb.get(rgb) ?? [];
    matches.push(material);
    byWangRgb.set(rgb, matches);
  }

  const encounteredByBiome = collectNonGrayWangRgbByBiome(tileLayers);
  const encountered = new Set(Array.from(encounteredByBiome.values()).flatMap((colors) => Array.from(colors)));
  for (const rgb of pixelSceneWangRgb) encountered.add(rgb & 0xffffff);
  const selected = new Map<string, CanonicalMaterialDefinition>();
  const ambiguousWangRgb: number[] = [];
  const spawnMarkerRgb = new Set<number>();
  const scalarFallbackRgb = new Set<number>();
  let resolvedWangRgbCount = 0;
  let wangRgbContextCount = 0;
  let resolvedWangRgbContextCount = 0;
  let spawnMarkerRgbContextCount = 0;
  let scalarFallbackRgbContextCount = 0;
  for (const [biomeName, colors] of encounteredByBiome) {
    for (const rgb of colors) {
      wangRgbContextCount += 1;
      const matches = byWangRgb.get(rgb) ?? [];
      if (matches.length === 0) {
        if (isKnownSpawnMarker(biomeName, rgb)) {
          spawnMarkerRgb.add(rgb);
          spawnMarkerRgbContextCount += 1;
        } else {
          scalarFallbackRgb.add(rgb);
          scalarFallbackRgbContextCount += 1;
        }
        continue;
      }
      resolvedWangRgbContextCount += 1;
      for (const material of matches) selected.set(material.id, material);
    }
  }
  for (const rgb of encountered) {
    const matches = byWangRgb.get(rgb) ?? [];
    if (matches.length > 1) ambiguousWangRgb.push(rgb);
    else if (matches.length === 1) resolvedWangRgbCount += 1;
    for (const material of matches) selected.set(material.id, material);
  }

  const zip = await getZip("terrain");
  if (!zip) throw new Error("[NativeMaterialAssets] terrain-assets.zip is unavailable");
  const configIndexFile = zip.file("terrain/biome-config-index.json");
  if (!configIndexFile) throw new Error("[NativeMaterialAssets] biome config index is missing");
  const configIndex = JSON.parse(await configIndexFile.async("string")) as Record<string, string>;
  const packageManifestFile = zip.file("terrain/manifest.json");
  if (!packageManifestFile) throw new Error("[NativeMaterialAssets] terrain package manifest is missing");
  const packageManifest = JSON.parse(await packageManifestFile.async("string")) as {
    schemaVersion: number;
    totals: {
      directEdgeGraphicsRecords?: number;
      directEdgeGraphicsImages?: number;
    };
    entries: Array<{ path: string; purpose: string }>;
  };
  const materialsXmlFile = zip.file("data/materials.xml");
  if (!materialsXmlFile) throw new Error("[NativeMaterialAssets] canonical data/materials.xml is missing");
  const edgeGraphics = parseDirectEdgeGraphicsInventory(await materialsXmlFile.async("string"));
  const packagedEdgePaths = packageManifest.entries
    .filter((entry) => entry.purpose === "authored-edge-graphics-image")
    .map((entry) => entry.path)
    .sort();
  if (
    edgeGraphics.directRecordCount !== (packageManifest.totals.directEdgeGraphicsRecords ?? -1) ||
    edgeGraphics.directImageCount !== (packageManifest.totals.directEdgeGraphicsImages ?? -1) ||
    JSON.stringify(edgeGraphics.uniqueImagePaths) !== JSON.stringify(packagedEdgePaths)
  ) {
    throw new Error("[NativeMaterialAssets] EdgeGraphics manifest does not match canonical materials.xml");
  }
  const edgeGraphicsImages = new Map<string, EdgeGraphicsStampImage>();
  await Promise.all(packagedEdgePaths.map(async (path) => {
    const file = zip.file(path);
    if (!file) throw new Error(`[NativeMaterialAssets] authored EdgeGraphics image is missing: ${path}`);
    const image = decodePngToRgba(await file.async("arraybuffer"));
    edgeGraphicsImages.set(path, { width: image.width, height: image.height, rgba: image.data });
  }));
  const biomeMaterials = new Map<string, BiomeMaterialsConfiguration>();
  const biomeVegetation = new Map<string, BiomeVegetationConfiguration>();
  const missingBiomeConfigurations: string[] = [];
  const biomeNames = Array.from(new Set(tileLayers.map((layer) => layer.biomeName).filter(Boolean))).sort();
  for (const biomeName of biomeNames) {
    const sourcePath = configIndex[biomeName] ?? null;
    if (!sourcePath) {
      missingBiomeConfigurations.push(biomeName);
      continue;
    }
    const file = zip.file(sourcePath);
    if (!file) throw new Error(`[NativeMaterialAssets] indexed biome configuration is missing: ${sourcePath}`);
    const xml = await file.async("string");
    const configuration = parseBiomeMaterialsConfiguration(xml, biomeName, sourcePath, materials);
    biomeMaterials.set(biomeName, configuration);
    const vegetation = parseBiomeVegetationConfiguration(xml, biomeName, sourcePath, materials);
    biomeVegetation.set(biomeName, vegetation);
    for (const record of configuration.records) {
      const material = record.materialId === null ? undefined : materials.find((candidate) => candidate.initial_id === record.materialId);
      if (material) selected.set(material.id, material);
    }
    for (const component of vegetation.components) {
      if (!component.isGrass || component.treeMaterialId === null) continue;
      const material = materials.find((candidate) => candidate.initial_id === component.treeMaterialId);
      if (material) selected.set(material.id, material);
    }
  }

  const texturePaths = Array.from(
    new Set(
      Array.from(selected.values(), (material) => material.graphics.texture_file).filter(Boolean),
    ),
  ).sort();
  const missingPaths = texturePaths.filter((path) => !decodedTextures.has(path));
  if (missingPaths.length > 0) {
    await Promise.all(
      missingPaths.map(async (path) => {
        const file = zip.file(path);
        if (!file) throw new Error(`[NativeMaterialAssets] authored texture is missing: ${path}`);
        const image = decodePngToRgba(await file.async("arraybuffer"));
        decodedTextures.set(path, { width: image.width, height: image.height, rgba: image.data });
      }),
    );
  }

  const report: NativeMaterialAssetReport = {
    packageSchemaVersion: packageManifest.schemaVersion,
    packageSha256: TERRAIN_ASSET_PACKAGE_SHA256,
    packageDeclaredEntries: packageManifest.entries.length,
    wangRgbCount: encountered.size,
    wangRgbContextCount,
    pixelSceneWangRgbCount: pixelSceneWangRgb.size,
    resolvedWangRgbCount,
    resolvedWangRgbContextCount,
    ambiguousWangRgb: ambiguousWangRgb.sort((left, right) => left - right),
    spawnMarkerRgb: Array.from(spawnMarkerRgb).sort((left, right) => left - right),
    spawnMarkerRgbContextCount,
    scalarFallbackRgb: Array.from(scalarFallbackRgb).sort((left, right) => left - right),
    scalarFallbackRgbContextCount,
    materialIds: Array.from(selected.keys()).sort(),
    texturePaths,
    edgeGraphicsDirectRecords: packageManifest.totals.directEdgeGraphicsRecords ?? 0,
    edgeGraphicsDirectImages: packageManifest.totals.directEdgeGraphicsImages ?? 0,
    edgeGraphicsEffectiveRecords: edgeGraphics.effectiveRecordCount,
    edgeGraphicsEffectiveImages: edgeGraphics.effectiveImageCount,
    edgeGraphicsAssetPaths: packagedEdgePaths,
    biomeConfigurationPaths: Array.from(biomeMaterials.values(), (configuration) => configuration.sourcePath).sort(),
    missingBiomeConfigurations,
    unresolvedBiomeMaterialNames: Array.from(
      new Set(Array.from(biomeMaterials.values()).flatMap((configuration) => configuration.unresolvedMaterialNames)),
    ).sort(),
    vegetationComponentCount: Array.from(biomeVegetation.values())
      .reduce((sum, configuration) => sum + configuration.components.length, 0),
    grassComponentCount: Array.from(biomeVegetation.values())
      .reduce((sum, configuration) => sum + configuration.components.filter((component) => component.isGrass).length, 0),
    unresolvedVegetationMaterialNames: Array.from(
      new Set(Array.from(biomeVegetation.values()).flatMap((configuration) => configuration.unresolvedMaterialNames)),
    ).sort(),
  };
  return {
    registry: new NativeMaterialAppearanceRegistry(materials, decodedTextures),
    biomeMaterials,
    biomeVegetation,
    edgeGraphics,
    edgeGraphicsImages,
    report,
  };
}
