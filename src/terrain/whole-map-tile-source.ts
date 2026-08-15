import type { TileLayer } from "../telescope/telescope-adapter";
import { BIOME_SPAWN_FUNCTION_MAP } from "../../lib/noita-telescope/js/spawn_function_config.js";
import Flatbush from "flatbush";
import type { NativeMaterialAppearanceRegistry } from "./material-appearance";
import { writeAabbggrr } from "./material-appearance";
import {
  resolvePixelSceneStampAt,
  samplePixelSceneArtwork,
  type CompiledPixelSceneStamp,
  type PixelSceneGeneratedWangView,
} from "./pixel-scene-stamp";
import type {
  BiomeMaterialsConfiguration,
  ProcessedWangMaterialBuffer,
} from "./wang-type2";
import {
  processWangMaterialBuffer,
  resolveWangType2Material,
} from "./wang-type2";
import {
  applyInteriorEdgeGraphicsChunk,
  applyPixelSceneEdgeGraphics,
  PIXEL_SCENE_AIR_MATERIAL,
  PIXEL_SCENE_PRESERVE_MATERIAL,
  type PixelSceneEdgeGraphicsPlane,
} from "./edge-graphics-renderer";
import {
  buildExperimentalEdgeGraphicsSchedule,
  EdgeGraphicsCheckpointBaker,
} from "./edge-graphics-schedule";
import type {
  EdgeGraphicsCellGrid,
  EdgeGraphicsInventory,
  EdgeGraphicsStampImage,
} from "./edge-graphics";
import {
  generateGrassOverlayRules,
  type BiomeVegetationConfiguration,
  type GrassOverlayRule,
} from "./vegetation";
import {
  renderedTerrainTileCache,
  terrainTileRenderQueue,
} from "./terrain-tile-runtime";
import {
  scanWholeMapTerrainCoverage,
  type WholeMapBiomeMap,
  type WholeMapTerrainCoverage,
} from "./whole-map-coverage";

export type {
  WholeMapBiomeMap,
  WholeMapTerrainCoverage,
} from "./whole-map-coverage";

declare const OpenSeadragon: any;

const TILE_SIZE = 512;
const WANG_CELL_SCALE = 10;
let sourceCounter = 0;

export interface WholeMapTerrainTileSourceResult {
  tileSource: any;
  originX: number;
  originY: number;
  width: number;
  height: number;
  coverage: WholeMapTerrainCoverage;
}

export interface WholeMapTerrainTileSourceOptions {
  worldSeed: number;
  biomeMaterials: ReadonlyMap<string, BiomeMaterialsConfiguration>;
  biomeVegetation?: ReadonlyMap<string, BiomeVegetationConfiguration>;
  worldCenter: number;
  parallelWorld: number;
  verticalPlane: number;
  worldWidthChunks: number;
  /** Stable seed/asset/world namespace for the bounded shared render cache. */
  cacheNamespace?: string;
  excludedBiomes?: ReadonlySet<string>;
  /** Paint unresolved routes with checkerboards for development inspection. */
  showResolutionDiagnostics?: boolean;
  /** Ordered native material-image stamps for this horizontal world. */
  pixelSceneStamps?: readonly CompiledPixelSceneStamp[];
  edgeGraphics?: EdgeGraphicsInventory;
  edgeGraphicsImages?: ReadonlyMap<string, EdgeGraphicsStampImage>;
  biomeMap?: WholeMapBiomeMap;
}

interface PositionedLayer {
  layer: TileLayer;
  x: number;
  y: number;
  wangOffsetX: number;
  wangOffsetY: number;
  width: number;
  height: number;
  processed: ProcessedWangMaterialBuffer;
  biomeMaterials: BiomeMaterialsConfiguration | null;
}

interface PositionedPixelSceneStamp {
  stamp: CompiledPixelSceneStamp;
  generated: PixelSceneGeneratedWangView | null;
  sequence: number;
}

const processedLayerCache = new WeakMap<
  TileLayer,
  ProcessedWangMaterialBuffer
>();
const sourceCoverageCache = new WeakMap<object, WholeMapTerrainCoverage>();

function isBiomeSpawnRgb(biomeName: string, rgb: number): boolean {
  const definitions = (
    BIOME_SPAWN_FUNCTION_MAP as Record<string, Array<{ color: number }>>
  )[biomeName];
  return !!definitions?.some((definition) => definition.color === rgb);
}

function resolutionDiagnosticPacked(
  status:
    | "missing-config"
    | "unsupported-smoothing"
    | "unresolved-material"
    | "unsupported-biome"
    | "missing-generated-layer",
  x: number,
  y: number,
): number {
  const alternate = ((x >>> 3) ^ (y >>> 3)) & 1;
  if (status === "unsupported-smoothing")
    return alternate ? 0xff00ffff : 0xff008080;
  if (status === "missing-config") return alternate ? 0xffff00ff : 0xff800080;
  if (status === "unsupported-biome")
    return alternate ? 0xff0040ff : 0xff002080;
  if (status === "missing-generated-layer")
    return alternate ? 0xff00a5ff : 0xff005080;
  return alternate ? 0xffffff00 : 0xff808000;
}

function sampledOutputRange(
  worldStart: number,
  worldEnd: number,
  tileWorldStart: number,
  worldScale: number,
  outputLength: number,
): readonly [number, number] {
  const start = Math.max(
    0,
    Math.ceil((worldStart - tileWorldStart) / worldScale),
  );
  const end = Math.min(
    outputLength,
    Math.ceil((worldEnd - tileWorldStart) / worldScale),
  );
  return [start, Math.max(start, end)];
}

export function createWholeMapTerrainTileSource(
  tileLayers: readonly TileLayer[],
  registry: NativeMaterialAppearanceRegistry,
  options: WholeMapTerrainTileSourceOptions,
): WholeMapTerrainTileSourceResult | null {
  const anchorY = -(14 * 512);
  const pwOffsetPixels = options.worldWidthChunks * 512;
  const layers: PositionedLayer[] = [];
  for (const layer of tileLayers) {
    if (!layer.buffer || options.excludedBiomes?.has(layer.biomeName)) continue;
    const centralWorldX = -(options.worldCenter * 512) + layer.correctedX;
    const x = centralWorldX + options.parallelWorld * pwOffsetPixels;
    const y = anchorY + layer.correctedY + options.verticalPlane * 24576;
    let processed = processedLayerCache.get(layer);
    if (!processed) {
      processed = processWangMaterialBuffer(
        layer.buffer,
        layer.width,
        layer.mapH,
        registry,
        4,
        (rgb) => isBiomeSpawnRgb(layer.biomeName, rgb),
      );
      processedLayerCache.set(layer, processed);
    }
    layers.push({
      layer,
      x,
      y,
      // BiomeManager publishes one loaded-map Wang offset. Horizontal parallel
      // worlds wrap the retained grid but keep absolute world coordinates for
      // Wang noise and material selection; do not cancel the PW displacement.
      wangOffsetX: -centralWorldX,
      wangOffsetY: -y,
      width: layer.width * WANG_CELL_SCALE,
      height: layer.mapH * WANG_CELL_SCALE,
      processed,
      biomeMaterials: options.biomeMaterials.get(layer.biomeName) ?? null,
    });
  }
  if (layers.length === 0 && !options.biomeMap) return null;

  const mapOriginX =
    -(options.worldCenter * 512) + options.parallelWorld * pwOffsetPixels;
  const mapOriginY = anchorY + options.verticalPlane * 24576;
  const mapMaxX = mapOriginX + (options.biomeMap?.width ?? 0) * 512;
  const mapMaxY = mapOriginY + (options.biomeMap?.height ?? 0) * 512;
  const originX = Math.min(
    ...(options.biomeMap ? [mapOriginX] : []),
    ...layers.map((entry) => entry.x),
  );
  const originY = Math.min(
    ...(options.biomeMap ? [mapOriginY] : []),
    ...layers.map((entry) => entry.y),
  );
  const maxX = Math.max(
    ...(options.biomeMap ? [mapMaxX] : []),
    ...layers.map((entry) => entry.x + entry.width),
  );
  const maxY = Math.max(
    ...(options.biomeMap ? [mapMaxY] : []),
    ...layers.map((entry) => entry.y + entry.height),
  );
  const width = Math.ceil(maxX - originX);
  const height = Math.ceil(maxY - originY);
  const positionedPixelSceneStamps: PositionedPixelSceneStamp[] = [];
  for (const stamp of options.pixelSceneStamps ?? []) {
    if (
      stamp.x >= maxX ||
      stamp.y >= maxY ||
      stamp.x + stamp.width <= originX ||
      stamp.y + stamp.height <= originY
    )
      continue;
    const centerX = stamp.x + Math.floor(stamp.width / 2);
    const centerY = stamp.y + Math.floor(stamp.height / 2);
    let selected: PositionedLayer | null = null;
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const candidate = layers[index];
      if (
        centerX >= candidate.x &&
        centerY >= candidate.y &&
        centerX < candidate.x + candidate.width &&
        centerY < candidate.y + candidate.height
      ) {
        selected = candidate;
        break;
      }
    }
    positionedPixelSceneStamps.push({
      stamp,
      sequence: positionedPixelSceneStamps.length,
      generated: selected
        ? {
            processed: selected.processed,
            biomeMaterials: selected.biomeMaterials,
            wangOffsetX: selected.wangOffsetX,
            wangOffsetY: selected.wangOffsetY,
          }
        : null,
    });
  }
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
  const sourceId = ++sourceCounter;
  const renderCacheNamespace = options.cacheNamespace ?? `source-${sourceId}`;
  const pixelSceneIndex =
    positionedPixelSceneStamps.length > 0
      ? new Flatbush(positionedPixelSceneStamps.length)
      : null;
  if (pixelSceneIndex) {
    for (const { stamp } of positionedPixelSceneStamps) {
      pixelSceneIndex.add(
        stamp.x,
        stamp.y,
        stamp.x + stamp.width,
        stamp.y + stamp.height,
      );
    }
    pixelSceneIndex.finish();
  }
  let firstEdgeTileReported = false;
  const coverageCacheKey = options.biomeMap?.pixels ?? (tileLayers as object);
  let coverage = sourceCoverageCache.get(coverageCacheKey);
  if (!coverage) {
    coverage = scanWholeMapTerrainCoverage(layers, registry, options.biomeMap);
    sourceCoverageCache.set(coverageCacheKey, coverage);
  }
  const wangBackedBiomes = new Set(
    layers.map((entry) => entry.layer.biomeName),
  );
  const biomeOccupancyStride = (options.biomeMap?.width ?? 0) + 1;
  const renderableBiomePrefix = options.biomeMap
    ? new Uint32Array(biomeOccupancyStride * (options.biomeMap.height + 1))
    : null;
  if (options.biomeMap && renderableBiomePrefix) {
    for (let chunkY = 0; chunkY < options.biomeMap.height; chunkY += 1) {
      let rowCount = 0;
      for (let chunkX = 0; chunkX < options.biomeMap.width; chunkX += 1) {
        const rgb =
          options.biomeMap.pixels[chunkY * options.biomeMap.width + chunkX] &
          0xffffff;
        const biomeName = options.biomeMap.colorToName.get(rgb);
        if (
          options.showResolutionDiagnostics ||
          (biomeName && wangBackedBiomes.has(biomeName))
        ) {
          rowCount += 1;
        }
        renderableBiomePrefix[
          (chunkY + 1) * biomeOccupancyStride + chunkX + 1
        ] =
          renderableBiomePrefix[chunkY * biomeOccupancyStride + chunkX + 1] +
          rowCount;
      }
    }
  }

  const biomeAtWorldPosition = (
    worldX: number,
    worldY: number,
  ): string | null | undefined => {
    const biomeMap = options.biomeMap;
    if (!biomeMap) return undefined;
    const chunkX = Math.floor((worldX - mapOriginX) / 512);
    const chunkY = Math.floor((worldY - mapOriginY) / 512);
    if (
      chunkX < 0 ||
      chunkY < 0 ||
      chunkX >= biomeMap.width ||
      chunkY >= biomeMap.height
    )
      return undefined;
    const rgb = biomeMap.pixels[chunkY * biomeMap.width + chunkX] & 0xffffff;
    return biomeMap.colorToName.get(rgb) ?? null;
  };

  const grassRuleCache = new Map<string, readonly GrassOverlayRule[]>();
  const grassRulesForChunk = (
    chunkOriginX: number,
    chunkOriginY: number,
  ): readonly GrassOverlayRule[] => {
    if (!options.biomeVegetation) return [];
    const biomeName = biomeAtWorldPosition(chunkOriginX + 256, chunkOriginY + 256);
    if (!biomeName) return [];
    const configuration = options.biomeVegetation.get(biomeName);
    if (!configuration) return [];
    const key = `${biomeName}/${chunkOriginX}`;
    const cached = grassRuleCache.get(key);
    if (cached) return cached;
    const rules = generateGrassOverlayRules(
      configuration,
      options.worldSeed,
      chunkOriginX,
      chunkOriginX + TILE_SIZE,
    ).rules;
    grassRuleCache.set(key, rules);
    coverage.grassOverlayRuleSetsResolved += 1;
    return rules;
  };

  const layersIntersecting = (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ) =>
    layers.filter(
      (entry) =>
        entry.x < endX &&
        entry.x + entry.width > startX &&
        entry.y < endY &&
        entry.y + entry.height > startY,
    );

  const pixelScenesIntersecting = (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    margin = 0,
  ): PositionedPixelSceneStamp[] => {
    if (!pixelSceneIndex) return [];
    return pixelSceneIndex
      .search(startX - margin, startY - margin, endX + margin, endY + margin)
      .sort((left, right) => left - right)
      .map((index) => positionedPixelSceneStamps[index]);
  };

  const hasPixelSceneIntersection = (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    margin = 0,
  ): boolean =>
    !!pixelSceneIndex &&
    pixelSceneIndex.search(
      startX - margin,
      startY - margin,
      endX + margin,
      endY + margin,
    ).length > 0;

  const resolveBaseTerrainAt = (
    worldX: number,
    worldY: number,
    candidates: readonly PositionedLayer[],
    sampleAppearance = true,
  ): {
    packed: number;
    materialId: number | null;
    sampledLayer: boolean;
    unsupportedBiome: boolean;
    closedAir: boolean;
    grassOverlay: boolean;
  } => {
    let packed = 0;
    let materialId: number | null = null;
    let sampledLayer = false;
    let closedAir = false;
    const biomeName = biomeAtWorldPosition(worldX, worldY);
    const unsupportedBiome =
      biomeName !== undefined &&
      (biomeName === null || !wangBackedBiomes.has(biomeName));
    if (unsupportedBiome) {
      if (options.showResolutionDiagnostics && sampleAppearance) {
        packed = resolutionDiagnosticPacked(
          "unsupported-biome",
          worldX,
          worldY,
        );
      }
      return { packed, materialId, sampledLayer, unsupportedBiome, closedAir, grassOverlay: false };
    }
    for (
      let candidateIndex = candidates.length - 1;
      candidateIndex >= 0;
      candidateIndex -= 1
    ) {
      const candidate = candidates[candidateIndex];
      if (
        worldX < candidate.x ||
        worldY < candidate.y ||
        worldX >= candidate.x + candidate.width ||
        worldY >= candidate.y + candidate.height
      )
        continue;
      sampledLayer = true;
      if (!candidate.biomeMaterials) {
        if (options.showResolutionDiagnostics && sampleAppearance) {
          packed = resolutionDiagnosticPacked("missing-config", worldX, worldY);
        }
        break;
      }
      const resolution = resolveWangType2Material(
        candidate.processed,
        candidate.biomeMaterials,
        registry,
        options.worldSeed,
        worldX,
        worldY,
        candidate.wangOffsetX,
        candidate.wangOffsetY,
      );
      if (resolution.status === "material") {
        materialId = resolution.materialId;
        if (sampleAppearance) {
          const sampled = registry.sample(
            resolution.materialId,
            worldX,
            worldY,
          );
          if (sampled.status !== "sampled") {
            throw new Error(
              `[WholeMapTerrainTileSource] ${sampled.status} for material ${resolution.materialId}`,
            );
          }
          packed = sampled.packedAabbggrr;
        }
      } else if (resolution.status === "air") {
        closedAir = true;
      } else if (
        options.showResolutionDiagnostics &&
        sampleAppearance
      ) {
        packed = resolutionDiagnosticPacked(
          resolution.status === "unsupported-smoothing"
            ? "unsupported-smoothing"
            : "unresolved-material",
          worldX,
          worldY,
        );
      }
      break;
    }
    if (
      !sampledLayer &&
      biomeName !== undefined &&
      options.showResolutionDiagnostics &&
      sampleAppearance
    ) {
      packed = resolutionDiagnosticPacked(
        "missing-generated-layer",
        worldX,
        worldY,
      );
    }
    return { packed, materialId, sampledLayer, unsupportedBiome, closedAir, grassOverlay: false };
  };

  const resolveTerrainAt = (
    worldX: number,
    worldY: number,
    candidates: readonly PositionedLayer[],
    sampleAppearance = true,
  ): ReturnType<typeof resolveBaseTerrainAt> => {
    const base = resolveBaseTerrainAt(worldX, worldY, candidates, sampleAppearance);
    if (base.materialId !== null || !base.closedAir || !options.biomeVegetation) return base;

    // Native's overlay loop can only publish into row-1 of the same 512-cell
    // generator. It excludes the two horizontal edge columns and cannot cross
    // the lower chunk boundary.
    const chunkOriginX = Math.floor(worldX / TILE_SIZE) * TILE_SIZE;
    const chunkOriginY = Math.floor(worldY / TILE_SIZE) * TILE_SIZE;
    const localX = worldX - chunkOriginX;
    const localY = worldY - chunkOriginY;
    if (localX <= 0 || localX >= TILE_SIZE - 1 || localY >= TILE_SIZE - 1) return base;
    const rules = grassRulesForChunk(chunkOriginX, chunkOriginY);
    if (rules.length === 0) return base;

    const terrainY = worldY + 1;
    const below = resolveBaseTerrainAt(worldX, terrainY, candidates, false);
    if (below.materialId === null) return base;
    let leftExists: boolean | undefined;
    let rightExists: boolean | undefined;
    for (const rule of rules) {
      if (rule.grassRequiresNeighbors) {
        leftExists ??= resolveBaseTerrainAt(worldX - 1, terrainY, candidates, false).materialId !== null;
        if (!leftExists) continue;
        rightExists ??= resolveBaseTerrainAt(worldX + 1, terrainY, candidates, false).materialId !== null;
        if (!rightExists) continue;
      }
      if (rule.materialOnTopOfId >= 0 && rule.materialOnTopOfId !== below.materialId) continue;
      let packed = 0;
      if (sampleAppearance) {
        const sampled = registry.sample(rule.treeMaterialId, worldX, worldY);
        if (sampled.status !== "sampled") {
          throw new Error(
            `[WholeMapTerrainTileSource] generated grass ${sampled.status} for material ${rule.treeMaterialId}`,
          );
        }
        packed = sampled.packedAabbggrr;
      }
      return {
        packed,
        materialId: rule.treeMaterialId,
        sampledLayer: true,
        unsupportedBiome: false,
        closedAir: false,
        grassOverlay: true,
      };
    }
    return base;
  };

  const resolveCompositeMaterialAt = (
    worldX: number,
    worldY: number,
    throughSceneSequence: number,
    terrainCandidates?: readonly PositionedLayer[],
    sceneCandidates?: readonly PositionedPixelSceneStamp[],
  ): number | null => {
    let materialId = resolveTerrainAt(
      worldX,
      worldY,
      terrainCandidates ??
        layersIntersecting(worldX, worldY, worldX + 1, worldY + 1),
      false,
    ).materialId;
    const orderedScenes = sceneCandidates ?? positionedPixelSceneStamps;
    for (const candidate of orderedScenes) {
      if (candidate.sequence > throughSceneSequence) break;
      const { stamp, generated } = candidate;
      if (
        worldX < stamp.x ||
        worldY < stamp.y ||
        worldX >= stamp.x + stamp.width ||
        worldY >= stamp.y + stamp.height
      )
        continue;
      const stamped = resolvePixelSceneStampAt(
        stamp,
        options.worldSeed,
        worldX,
        worldY,
        generated,
      );
      if (stamped.status === "preserve") continue;
      materialId = stamped.status === "air" ? null : stamped.materialId;
    }
    return materialId;
  };

  const buildPixelSceneEdgePlane = (
    positioned: PositionedPixelSceneStamp,
  ): {
    plane: PixelSceneEdgeGraphicsPlane;
    materialAtWorld: (worldX: number, worldY: number) => number | null;
  } => {
    const { stamp, sequence } = positioned;
    const materialIds = new Int32Array(stamp.width * stamp.height);
    materialIds.fill(PIXEL_SCENE_AIR_MATERIAL);
    const stampedMaterialIds = new Int32Array(stamp.width * stamp.height);
    stampedMaterialIds.fill(PIXEL_SCENE_PRESERVE_MATERIAL);
    const terrainCandidates = layersIntersecting(
      stamp.x - 6,
      stamp.y - 6,
      stamp.x + stamp.width + 6,
      stamp.y + stamp.height + 6,
    );
    const sceneCandidates = pixelScenesIntersecting(
      stamp.x,
      stamp.y,
      stamp.x + stamp.width,
      stamp.y + stamp.height,
      6,
    ).filter((candidate) => candidate.sequence <= sequence);
    for (let localY = 0; localY < stamp.height; localY += 1) {
      for (let localX = 0; localX < stamp.width; localX += 1) {
        const worldX = stamp.x + localX;
        const worldY = stamp.y + localY;
        const index = localY * stamp.width + localX;
        const currentWrite = resolvePixelSceneStampAt(
          stamp,
          options.worldSeed,
          worldX,
          worldY,
          positioned.generated,
        );
        if (currentWrite.status === "air")
          stampedMaterialIds[index] = PIXEL_SCENE_AIR_MATERIAL;
        else if (currentWrite.status === "material")
          stampedMaterialIds[index] = currentWrite.materialId;
        materialIds[index] =
          resolveCompositeMaterialAt(
            worldX,
            worldY,
            sequence,
            terrainCandidates,
            sceneCandidates,
          ) ?? PIXEL_SCENE_AIR_MATERIAL;
      }
    }
    const cache = new Map<string, number | null>();
    return {
      plane: {
        width: stamp.width,
        height: stamp.height,
        materialIds,
        stampedMaterialIds,
      },
      materialAtWorld: (worldX: number, worldY: number) => {
        const key = `${worldX},${worldY}`;
        if (cache.has(key)) return cache.get(key) ?? null;
        const materialId = resolveCompositeMaterialAt(
          worldX,
          worldY,
          sequence,
          terrainCandidates,
          sceneCandidates,
        );
        cache.set(key, materialId);
        return materialId;
      },
    };
  };

  const buildEdgeGrid = (
    chunkX: number,
    chunkY: number,
    sampleAppearance: boolean,
  ) => {
    const chunkOriginX = chunkX * TILE_SIZE;
    const chunkOriginY = chunkY * TILE_SIZE;
    const candidates = layersIntersecting(
      chunkOriginX,
      chunkOriginY,
      chunkOriginX + TILE_SIZE,
      chunkOriginY + TILE_SIZE,
    );
    const grid: EdgeGraphicsCellGrid = {
      width: TILE_SIZE,
      height: TILE_SIZE,
      cells: new Array(TILE_SIZE * TILE_SIZE).fill(null),
    };
    const basePacked = sampleAppearance
      ? new Uint32Array(TILE_SIZE * TILE_SIZE)
      : null;
    for (let localY = 0; localY < TILE_SIZE; localY += 1) {
      for (let localX = 0; localX < TILE_SIZE; localX += 1) {
        const cellIndex = localY * TILE_SIZE + localX;
        const resolved = resolveTerrainAt(
          chunkOriginX + localX,
          chunkOriginY + localY,
          candidates,
          sampleAppearance,
        );
        if (sampleAppearance && resolved.grassOverlay) coverage.grassOverlayCellsRendered += 1;
        if (basePacked) basePacked[cellIndex] = resolved.packed;
        if (resolved.materialId === null) continue;
        const material = registry.materialAtInitialId(resolved.materialId);
        const concreteType =
          material?.cell_type === "liquid" ||
          material?.cell_type === "gas" ||
          material?.cell_type === "fire"
            ? material.cell_type
            : "solid";
        grid.cells[cellIndex] = {
          materialId: resolved.materialId,
          visualAabbggrr: resolved.packed,
          markerAabbggrr: resolved.packed,
          concreteType,
        };
      }
    }
    return { grid, basePacked };
  };

  const minimumChunkX = Math.floor(originX / TILE_SIZE);
  const maximumChunkX = Math.floor((maxX - 1) / TILE_SIZE);
  const minimumChunkY = Math.floor(originY / TILE_SIZE);
  const maximumChunkY = Math.floor((maxY - 1) / TILE_SIZE);
  const edgeCheckpointBaker = options.edgeGraphics
    ? new EdgeGraphicsCheckpointBaker(
        buildExperimentalEdgeGraphicsSchedule(
          minimumChunkX,
          maximumChunkX,
          minimumChunkY,
          maximumChunkY,
        ),
        registry,
        options.edgeGraphics,
        (chunkX, chunkY) => buildEdgeGrid(chunkX, chunkY, false).grid,
        options.worldSeed,
      )
    : null;

  const tileWorldBounds = (level: number, tileX: number, tileY: number) => {
    const scale = 2 ** (maxLevel - level);
    const localStartX = tileX * TILE_SIZE * scale;
    const localStartY = tileY * TILE_SIZE * scale;
    const outputWidth = Math.min(
      TILE_SIZE,
      Math.max(0, Math.ceil((width - localStartX) / scale)),
    );
    const outputHeight = Math.min(
      TILE_SIZE,
      Math.max(0, Math.ceil((height - localStartY) / scale)),
    );
    const startX = originX + localStartX;
    const startY = originY + localStartY;
    return {
      scale,
      localStartX,
      localStartY,
      outputWidth,
      outputHeight,
      startX,
      startY,
      endX: startX + outputWidth * scale,
      endY: startY + outputHeight * scale,
    };
  };

  const tileHasRenderableTerrain = (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): boolean => {
    const biomeMap = options.biomeMap;
    if (!biomeMap)
      return layersIntersecting(startX, startY, endX, endY).length > 0;
    const firstChunkX = Math.max(
      0,
      Math.floor((startX - mapOriginX) / TILE_SIZE),
    );
    const firstChunkY = Math.max(
      0,
      Math.floor((startY - mapOriginY) / TILE_SIZE),
    );
    const lastChunkX = Math.min(
      biomeMap.width - 1,
      Math.floor((endX - 1 - mapOriginX) / TILE_SIZE),
    );
    const lastChunkY = Math.min(
      biomeMap.height - 1,
      Math.floor((endY - 1 - mapOriginY) / TILE_SIZE),
    );
    if (firstChunkX > lastChunkX || firstChunkY > lastChunkY) return false;
    if (!renderableBiomePrefix) return false;
    const left = firstChunkX;
    const top = firstChunkY;
    const right = lastChunkX + 1;
    const bottom = lastChunkY + 1;
    const count =
      renderableBiomePrefix[bottom * biomeOccupancyStride + right] -
      renderableBiomePrefix[top * biomeOccupancyStride + right] -
      renderableBiomePrefix[bottom * biomeOccupancyStride + left] +
      renderableBiomePrefix[top * biomeOccupancyStride + left];
    return count > 0;
  };

  const source = new OpenSeadragon.TileSource({
    width,
    height,
    tileSize: TILE_SIZE,
    minLevel: 0,
    maxLevel,
  });
  source.getTileUrl = (level: number, x: number, y: number) =>
    `reconstructed-terrain://${sourceId}/${level}/${x}/${y}`;
  source.hasTransparency = () => true;
  source.tileExists = (level: number, tileX: number, tileY: number) => {
    const bounds = tileWorldBounds(level, tileX, tileY);
    if (bounds.outputWidth <= 0 || bounds.outputHeight <= 0) return false;
    const sceneMargin = level === maxLevel && options.edgeGraphics ? 80 : 0;
    if (
      hasPixelSceneIntersection(
        bounds.startX,
        bounds.startY,
        bounds.endX,
        bounds.endY,
        sceneMargin,
      )
    ) {
      return true;
    }
    return tileHasRenderableTerrain(
      bounds.startX,
      bounds.startY,
      bounds.endX,
      bounds.endY,
    );
  };
  source.downloadTileAbort = (context: any) =>
    terrainTileRenderQueue.cancel(context);
  source.downloadTileStart = (context: any) => {
    const { level, x: tileX, y: tileY } = context.tile;
    const tileCacheKey = `${renderCacheNamespace}/${level}/${tileX}/${tileY}`;
    const cachedCanvas = renderedTerrainTileCache.get(tileCacheKey);
    if (cachedCanvas) {
      queueMicrotask(() => context.finish(cachedCanvas, null, "image"));
      return;
    }

    terrainTileRenderQueue.enqueue(context, () => {
      // A duplicate request may have joined the queue before the first copy
      // completed. Recheck here so queued work is coalesced by the cache.
      const queuedCacheHit = renderedTerrainTileCache.get(tileCacheKey);
      if (queuedCacheHit) {
        queueMicrotask(() => context.finish(queuedCacheHit, null, "image"));
        return;
      }
      const startedAt =
        typeof performance === "undefined" ? 0 : performance.now();
      const bounds = tileWorldBounds(level, tileX, tileY);
      const { scale } = bounds;
      const canvas = document.createElement("canvas");
      canvas.width = bounds.outputWidth;
      canvas.height = bounds.outputHeight;
      const drawing = canvas.getContext("2d");
      if (!drawing)
        throw new Error("[WholeMapTerrainTileSource] Canvas 2D is unavailable");
      const image = drawing.createImageData(canvas.width, canvas.height);

      const absoluteStartX = bounds.startX;
      const absoluteStartY = bounds.startY;
      const absoluteEndX = bounds.endX;
      const absoluteEndY = bounds.endY;
      const candidates = layersIntersecting(
        absoluteStartX,
        absoluteStartY,
        absoluteEndX,
        absoluteEndY,
      );
      const pixelSceneCandidates = pixelScenesIntersecting(
        absoluteStartX,
        absoluteStartY,
        absoluteEndX,
        absoluteEndY,
      );
      // The largest admitted authored edge image is 160 pixels. A scene anchor
      // just outside this tile can therefore still paint a target inside it.
      const pixelSceneEdgeCandidates = pixelScenesIntersecting(
        absoluteStartX,
        absoluteStartY,
        absoluteEndX,
        absoluteEndY,
        80,
      );

      let edgeGrid: EdgeGraphicsCellGrid | null = null;
      let edgeBasePacked: Uint32Array | null = null;
      if (
        scale === 1 &&
        canvas.width === TILE_SIZE &&
        canvas.height === TILE_SIZE &&
        absoluteStartX % TILE_SIZE === 0 &&
        absoluteStartY % TILE_SIZE === 0 &&
        options.edgeGraphics &&
        options.edgeGraphicsImages
      ) {
        const chunkX = absoluteStartX / TILE_SIZE;
        const chunkY = absoluteStartY / TILE_SIZE;
        const built = buildEdgeGrid(chunkX, chunkY, true);
        edgeGrid = built.grid;
        edgeBasePacked = built.basePacked;
        const checkpoint =
          edgeCheckpointBaker?.checkpointFor(chunkX, chunkY) ?? null;
        const edgeResult = applyInteriorEdgeGraphicsChunk(
          edgeGrid,
          absoluteStartX,
          absoluteStartY,
          registry,
          options.edgeGraphics,
          options.edgeGraphicsImages,
          checkpoint?.rngInitialState,
        );
        if (checkpoint) {
          coverage.edgeScheduledChunksRendered += 1;
          if (checkpoint.stateSource === "worker-replay")
            coverage.edgeWorkerReplayChunksRendered += 1;
          else coverage.edgeCanonicalSeededChunksRendered += 1;
        } else coverage.edgeUnscheduledChunksRendered += 1;
        coverage.edgeInteriorChunksRendered += 1;
        coverage.edgeInteriorStampCalls += edgeResult.stampCalls;
        coverage.edgeInteriorWrittenPixels += edgeResult.writtenPixels;
        coverage.edgeInteriorMissingImages = Array.from(
          new Set([
            ...coverage.edgeInteriorMissingImages,
            ...edgeResult.missingImages,
          ]),
        ).sort();
        // The exact interior scan excludes the outer eight cells on every side.
        // Those pixels remain authored base terrain until the native border RNG
        // phase can be supplied by the standalone generation schedule.
        coverage.edgeBorderPixelsLegacyFallback +=
          TILE_SIZE * TILE_SIZE - (TILE_SIZE - 16) ** 2;
        if (!firstEdgeTileReported) {
          firstEdgeTileReported = true;
          console.info(
            "[ReconstructedTerrain] first native-scale interior EdgeGraphics tile",
            {
              chunkOriginX: absoluteStartX,
              chunkOriginY: absoluteStartY,
              stampCalls: edgeResult.stampCalls,
              writtenPixels: edgeResult.writtenPixels,
              missingImages: edgeResult.missingImages,
              rngInitialState: edgeResult.rngInitialState,
              rngFinalState: edgeResult.rngFinalState,
              scheduleId:
                checkpoint?.scheduleId ?? "unavailable-reset-fallback",
              scheduleIndex: checkpoint?.scheduleIndex ?? null,
              workerIndex: checkpoint?.workerIndex ?? null,
              workerCount: checkpoint?.workerCount ?? null,
              stateSource:
                checkpoint?.stateSource ?? "unavailable-reset-fallback",
            },
          );
        }

        for (const positioned of pixelSceneEdgeCandidates) {
          const { stamp, generated, sequence } = positioned;
          const sceneStartX = Math.max(absoluteStartX, stamp.x);
          const sceneStartY = Math.max(absoluteStartY, stamp.y);
          const sceneEndX = Math.min(absoluteEndX, stamp.x + stamp.width);
          const sceneEndY = Math.min(absoluteEndY, stamp.y + stamp.height);
          for (let worldY = sceneStartY; worldY < sceneEndY; worldY += 1) {
            for (let worldX = sceneStartX; worldX < sceneEndX; worldX += 1) {
              const stamped = resolvePixelSceneStampAt(
                stamp,
                options.worldSeed,
                worldX,
                worldY,
                generated,
              );
              if (stamped.status === "preserve") continue;
              const localX = worldX - absoluteStartX;
              const localY = worldY - absoluteStartY;
              const cellIndex = localY * TILE_SIZE + localX;
              if (stamped.status === "air") {
                edgeGrid.cells[cellIndex] = null;
                if (edgeBasePacked) edgeBasePacked[cellIndex] = 0;
                continue;
              }
              const sampled = registry.sample(
                stamped.materialId,
                worldX,
                worldY,
              );
              if (sampled.status !== "sampled") {
                throw new Error(
                  `[WholeMapTerrainTileSource] PixelScene ${sampled.status} for material ${stamped.materialId} in ${stamp.key}`,
                );
              }
              const packed =
                samplePixelSceneArtwork(stamp, "visual", worldX, worldY) ??
                sampled.packedAabbggrr;
              const material = registry.materialAtInitialId(stamped.materialId);
              const concreteType =
                material?.cell_type === "liquid" ||
                material?.cell_type === "gas" ||
                material?.cell_type === "fire"
                  ? material.cell_type
                  : "solid";
              edgeGrid.cells[cellIndex] = {
                materialId: stamped.materialId,
                visualAabbggrr: packed,
                markerAabbggrr: packed,
                concreteType,
              };
              if (edgeBasePacked) edgeBasePacked[cellIndex] = packed;
            }
          }
          if (stamp.skipEdgeTextures) {
            coverage.pixelSceneEdgeSkippedByMetadata += 1;
            continue;
          }
          const builtScene = buildPixelSceneEdgePlane(positioned);
          const sceneEdgeResult = applyPixelSceneEdgeGraphics(
            edgeGrid,
            absoluteStartX,
            absoluteStartY,
            stamp.x,
            stamp.y,
            sequence,
            options.worldSeed,
            builtScene.plane,
            builtScene.materialAtWorld,
            registry,
            options.edgeGraphics,
            options.edgeGraphicsImages,
          );
          coverage.pixelSceneEdgeScenesRendered += 1;
          coverage.pixelSceneEdgeStampCalls += sceneEdgeResult.stampCalls;
          coverage.pixelSceneEdgeWrittenPixels += sceneEdgeResult.writtenPixels;
          coverage.pixelSceneEdgeTargetsOutsideTile +=
            sceneEdgeResult.targetPixelsOutsideTile;
          coverage.pixelSceneEdgeMissingImages = Array.from(
            new Set([
              ...coverage.pixelSceneEdgeMissingImages,
              ...sceneEdgeResult.missingImages,
            ]),
          ).sort();
        }
      }

      // Compose ordered PixelScene samples by each scene's actual output-space
      // bounds. The former inner loop tested every scene candidate for every
      // output pixel, which multiplied work badly in scene-dense biomes. Flatbush
      // supplies source indices and pixelScenesIntersecting sorts them, so later
      // scenes still overwrite earlier scenes exactly as before.
      const outputPixelCount = canvas.width * canvas.height;
      const pixelSceneBackground =
        pixelSceneCandidates.length > 0
          ? new Uint32Array(outputPixelCount)
          : null;
      const pixelSceneTerrainState =
        !edgeGrid && pixelSceneCandidates.length > 0
          ? new Int32Array(outputPixelCount)
          : null;
      const pixelSceneTerrainPacked = pixelSceneTerrainState
        ? new Uint32Array(outputPixelCount)
        : null;
      pixelSceneTerrainState?.fill(PIXEL_SCENE_PRESERVE_MATERIAL);

      for (const { stamp, generated } of pixelSceneCandidates) {
        const [startOutputX, endOutputX] = sampledOutputRange(
          stamp.x,
          stamp.x + stamp.width,
          absoluteStartX,
          scale,
          canvas.width,
        );
        const [startOutputY, endOutputY] = sampledOutputRange(
          stamp.y,
          stamp.y + stamp.height,
          absoluteStartY,
          scale,
          canvas.height,
        );
        for (let outputY = startOutputY; outputY < endOutputY; outputY += 1) {
          const worldY = Math.floor(absoluteStartY + outputY * scale);
          for (let outputX = startOutputX; outputX < endOutputX; outputX += 1) {
            const worldX = Math.floor(absoluteStartX + outputX * scale);
            const outputIndex = outputY * canvas.width + outputX;
            const background = samplePixelSceneArtwork(
              stamp,
              "background",
              worldX,
              worldY,
            );
            if (background !== null && pixelSceneBackground)
              pixelSceneBackground[outputIndex] = background;
            if (!pixelSceneTerrainState || !pixelSceneTerrainPacked) continue;
            const stamped = resolvePixelSceneStampAt(
              stamp,
              options.worldSeed,
              worldX,
              worldY,
              generated,
            );
            if (stamped.status === "preserve") continue;
            if (stamped.status === "air") {
              pixelSceneTerrainState[outputIndex] = PIXEL_SCENE_AIR_MATERIAL;
              pixelSceneTerrainPacked[outputIndex] = 0;
              continue;
            }
            const sampled = registry.sample(stamped.materialId, worldX, worldY);
            if (sampled.status !== "sampled") {
              throw new Error(
                `[WholeMapTerrainTileSource] PixelScene ${sampled.status} for material ${stamped.materialId} in ${stamp.key}`,
              );
            }
            pixelSceneTerrainState[outputIndex] = stamped.materialId;
            pixelSceneTerrainPacked[outputIndex] =
              samplePixelSceneArtwork(stamp, "visual", worldX, worldY) ??
              sampled.packedAabbggrr;
          }
        }
      }

      for (let outputY = 0; outputY < canvas.height; outputY += 1) {
        const worldY = Math.floor(absoluteStartY + outputY * scale);
        for (let outputX = 0; outputX < canvas.width; outputX += 1) {
          const worldX = Math.floor(absoluteStartX + outputX * scale);
          const cellIndex = outputY * canvas.width + outputX;
          let packed: number;
          if (edgeGrid && edgeBasePacked) {
            packed =
              edgeGrid.cells[cellIndex]?.visualAabbggrr ??
              edgeBasePacked[cellIndex];
          } else {
            const resolved = resolveTerrainAt(worldX, worldY, candidates);
            packed = resolved.packed;
            if (resolved.grassOverlay) coverage.grassOverlayCellsRendered += 1;
          }
          const terrainState =
            pixelSceneTerrainState?.[cellIndex] ??
            PIXEL_SCENE_PRESERVE_MATERIAL;
          if (terrainState === PIXEL_SCENE_AIR_MATERIAL) {
            packed = 0;
          } else if (terrainState >= 0 && pixelSceneTerrainPacked) {
            packed = pixelSceneTerrainPacked[cellIndex];
          }
          // PixelScene backgrounds are behind GridWorld cells. They become
          // visible only where the final ordered terrain result is air.
          const background = pixelSceneBackground?.[cellIndex] ?? 0;
          if (packed === 0 && background !== 0) packed = background;
          writeAabbggrr(
            image.data,
            (outputY * canvas.width + outputX) * 4,
            packed,
          );
        }
      }
      drawing.putImageData(image, 0, 0);
      renderedTerrainTileCache.set(tileCacheKey, canvas);
      const elapsedMs = startedAt === 0 ? 0 : performance.now() - startedAt;
      renderedTerrainTileCache.recordRender(elapsedMs);
      queueMicrotask(() => context.finish(canvas, null, "image"));
    });
  };

  return { tileSource: source, originX, originY, width, height, coverage };
}
