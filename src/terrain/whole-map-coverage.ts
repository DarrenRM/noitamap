import type { TileLayer } from "../telescope/telescope-adapter";
import { PIXEL_SCENE_EDGE_STATE_POLICY } from "./edge-graphics-renderer";
import { EXPERIMENTAL_EDGE_SCHEDULE_ID } from "./edge-graphics-schedule";
import type { NativeMaterialAppearanceRegistry } from "./material-appearance";
import type {
  BiomeMaterialsConfiguration,
  ProcessedWangMaterialBuffer,
} from "./wang-type2";

export interface WholeMapCoverageLayer {
  layer: Pick<TileLayer, "biomeName">;
  processed: ProcessedWangMaterialBuffer;
  biomeMaterials: BiomeMaterialsConfiguration | null;
}

export interface WholeMapBiomeMap {
  pixels: Uint32Array;
  width: number;
  height: number;
  colorToName: ReadonlyMap<number, string>;
}

export interface WholeMapTerrainCoverage {
  low24BlackPixels: number;
  directMaterialPixels: number;
  spawnMarkerPixels: number;
  scalarFallbackPixels: number;
  materialIds: number[];
  spawnMarkerRgb: number[];
  scalarFallbackRgb: number[];
  type2LayerCount: number;
  processedInitialMaterialPixelsBySmoothingType: Record<string, number>;
  processedInitialMaterialIdsBySmoothingType: Record<string, number[]>;
  processedInitialMaterialsBySmoothingType: Record<
    string,
    Array<{
      materialId: number;
      materialName: string;
      pixels: number;
      biomeNames: string[];
    }>
  >;
  declaredBiomeMapChunks: number;
  wangBackedBiomeMapChunks: number;
  unsupportedBiomeMapChunks: number;
  unsupportedBiomeMapChunksByName: Record<string, number>;
  missingBiomeConfigurations: string[];
  unresolvedBiomeMaterialNames: string[];
  grassOverlayCellsRendered: number;
  grassOverlayRuleSetsResolved: number;
  edgeInteriorChunksRendered: number;
  edgeInteriorStampCalls: number;
  edgeInteriorWrittenPixels: number;
  edgeInteriorMissingImages: string[];
  edgeScheduledChunksRendered: number;
  edgeWorkerReplayChunksRendered: number;
  edgeCanonicalSeededChunksRendered: number;
  edgeUnscheduledChunksRendered: number;
  edgeScheduleId: string;
  /** Native cross-chunk border pass is kept separate until its RNG phase is supplied. */
  edgeBorderPixelsLegacyFallback: number;
  pixelSceneEdgeScenesRendered: number;
  pixelSceneEdgeStampCalls: number;
  pixelSceneEdgeWrittenPixels: number;
  pixelSceneEdgeTargetsOutsideTile: number;
  pixelSceneEdgeSkippedByMetadata: number;
  pixelSceneEdgeMissingImages: string[];
  pixelSceneEdgeStatePolicy: string;
}

export function scanWholeMapTerrainCoverage(
  layers: readonly WholeMapCoverageLayer[],
  registry: NativeMaterialAppearanceRegistry,
  biomeMap?: WholeMapBiomeMap,
): WholeMapTerrainCoverage {
  const coverage: WholeMapTerrainCoverage = {
    low24BlackPixels: 0,
    directMaterialPixels: 0,
    spawnMarkerPixels: 0,
    scalarFallbackPixels: 0,
    materialIds: [],
    spawnMarkerRgb: [],
    scalarFallbackRgb: [],
    type2LayerCount: layers.length,
    processedInitialMaterialPixelsBySmoothingType: {},
    processedInitialMaterialIdsBySmoothingType: {},
    processedInitialMaterialsBySmoothingType: {},
    declaredBiomeMapChunks: biomeMap?.pixels.length ?? 0,
    wangBackedBiomeMapChunks: 0,
    unsupportedBiomeMapChunks: 0,
    unsupportedBiomeMapChunksByName: {},
    missingBiomeConfigurations: [],
    unresolvedBiomeMaterialNames: [],
    grassOverlayCellsRendered: 0,
    grassOverlayRuleSetsResolved: 0,
    edgeInteriorChunksRendered: 0,
    edgeInteriorStampCalls: 0,
    edgeInteriorWrittenPixels: 0,
    edgeInteriorMissingImages: [],
    edgeScheduledChunksRendered: 0,
    edgeWorkerReplayChunksRendered: 0,
    edgeCanonicalSeededChunksRendered: 0,
    edgeUnscheduledChunksRendered: 0,
    edgeScheduleId: EXPERIMENTAL_EDGE_SCHEDULE_ID,
    edgeBorderPixelsLegacyFallback: 0,
    pixelSceneEdgeScenesRendered: 0,
    pixelSceneEdgeStampCalls: 0,
    pixelSceneEdgeWrittenPixels: 0,
    pixelSceneEdgeTargetsOutsideTile: 0,
    pixelSceneEdgeSkippedByMetadata: 0,
    pixelSceneEdgeMissingImages: [],
    pixelSceneEdgeStatePolicy: PIXEL_SCENE_EDGE_STATE_POLICY,
  };
  const materialIds = new Set<number>();
  const spawnMarkerRgb = new Set<number>();
  const scalarFallbackRgb = new Set<number>();
  const smoothingMaterialIds = new Map<number, Set<number>>();
  const smoothingMaterialCoverage = new Map<
    number,
    Map<
      number,
      {
        pixels: number;
        biomeNames: Set<string>;
      }
    >
  >();
  for (const { layer, processed } of layers) {
    coverage.low24BlackPixels += processed.branchCounts.low24Black;
    coverage.directMaterialPixels += processed.branchCounts.material;
    coverage.spawnMarkerPixels += processed.branchCounts.spawn;
    coverage.scalarFallbackPixels += processed.branchCounts.scalarFallback;
    for (const materialId of processed.directMaterialIds)
      materialIds.add(materialId);
    for (const rgb of processed.spawnRgb) spawnMarkerRgb.add(rgb);
    for (const rgb of processed.scalarFallbackRgb) scalarFallbackRgb.add(rgb);
    for (const storedMaterialId of processed.materialGrid.pixels) {
      const materialId = storedMaterialId - 1;
      if (materialId <= 0) continue;
      const smoothingType =
        registry.materialAtInitialId(materialId)?.wang_noise_type ?? 0;
      const key = String(smoothingType);
      coverage.processedInitialMaterialPixelsBySmoothingType[key] =
        (coverage.processedInitialMaterialPixelsBySmoothingType[key] ?? 0) + 1;
      const ids = smoothingMaterialIds.get(smoothingType) ?? new Set<number>();
      ids.add(materialId);
      smoothingMaterialIds.set(smoothingType, ids);
      const byMaterial =
        smoothingMaterialCoverage.get(smoothingType) ?? new Map();
      const materialCoverage = byMaterial.get(materialId) ?? {
        pixels: 0,
        biomeNames: new Set<string>(),
      };
      materialCoverage.pixels += 1;
      materialCoverage.biomeNames.add(layer.biomeName);
      byMaterial.set(materialId, materialCoverage);
      smoothingMaterialCoverage.set(smoothingType, byMaterial);
    }
  }
  if (biomeMap) {
    const wangBackedBiomes = new Set(
      layers.map((entry) => entry.layer.biomeName),
    );
    for (const packedColor of biomeMap.pixels) {
      const rgb = packedColor & 0xffffff;
      const biomeName =
        biomeMap.colorToName.get(rgb) ??
        `#${rgb.toString(16).padStart(6, "0").toUpperCase()}`;
      if (wangBackedBiomes.has(biomeName)) {
        coverage.wangBackedBiomeMapChunks += 1;
      } else {
        coverage.unsupportedBiomeMapChunks += 1;
        coverage.unsupportedBiomeMapChunksByName[biomeName] =
          (coverage.unsupportedBiomeMapChunksByName[biomeName] ?? 0) + 1;
      }
    }
    coverage.unsupportedBiomeMapChunksByName = Object.fromEntries(
      Object.entries(coverage.unsupportedBiomeMapChunksByName).sort(
        ([left], [right]) => left.localeCompare(right),
      ),
    );
  }
  coverage.materialIds = Array.from(materialIds).sort(
    (left, right) => left - right,
  );
  coverage.spawnMarkerRgb = Array.from(spawnMarkerRgb).sort(
    (left, right) => left - right,
  );
  coverage.scalarFallbackRgb = Array.from(scalarFallbackRgb).sort(
    (left, right) => left - right,
  );
  coverage.processedInitialMaterialIdsBySmoothingType = Object.fromEntries(
    Array.from(smoothingMaterialIds.entries())
      .sort(([left], [right]) => left - right)
      .map(([smoothingType, ids]) => [
        String(smoothingType),
        Array.from(ids).sort((left, right) => left - right),
      ]),
  );
  coverage.processedInitialMaterialsBySmoothingType = Object.fromEntries(
    Array.from(smoothingMaterialCoverage.entries())
      .sort(([left], [right]) => left - right)
      .map(([smoothingType, byMaterial]) => [
        String(smoothingType),
        Array.from(byMaterial.entries())
          .sort(([left], [right]) => left - right)
          .map(([materialId, entry]) => ({
            materialId,
            materialName:
              registry.materialAtInitialId(materialId)?.id ??
              `<unresolved:${materialId}>`,
            pixels: entry.pixels,
            biomeNames: Array.from(entry.biomeNames).sort(),
          })),
      ]),
  );
  coverage.missingBiomeConfigurations = Array.from(
    new Set(
      layers
        .filter((entry) => !entry.biomeMaterials)
        .map((entry) => entry.layer.biomeName),
    ),
  ).sort();
  coverage.unresolvedBiomeMaterialNames = Array.from(
    new Set(
      layers.flatMap(
        (entry) => entry.biomeMaterials?.unresolvedMaterialNames ?? [],
      ),
    ),
  ).sort();
  return coverage;
}
