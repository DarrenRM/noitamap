import type { CanonicalMaterialDefinition, NativeMaterialAppearanceRegistry } from "./material-appearance";
import {
  fbmNoise4Octaves,
  polkaDotNoise,
  simplexNoise1234,
  simplexNoiseEvaluate,
  wangGradientNoise2d,
  wangValueNoise2d,
} from "./noita-noise";

const f32 = Math.fround;
const fadd = (left: number, right: number) => f32(f32(left) + f32(right));
const fsub = (left: number, right: number) => f32(f32(left) - f32(right));
const fmul = (left: number, right: number) => f32(f32(left) * f32(right));
const fdiv = (left: number, right: number) => f32(f32(left) / f32(right));

export interface WangFloatGrid {
  width: number;
  height: number;
  pixels: Float32Array;
}

export interface WangMaterialGrid {
  width: number;
  height: number;
  /** Native stores initial material ID + 1; zero means no direct identity. */
  pixels: Uint16Array;
}

export interface ProcessedWangMaterialBuffer {
  floatGrid: WangFloatGrid;
  materialGrid: WangMaterialGrid;
  directMaterialIds: number[];
  /** Registered biome callback colors retained by the separate spawn/PixelScene route. */
  spawnRgb: number[];
  /** Non-material, non-spawn colors consumed by native's exact scalar fallback expression. */
  scalarFallbackRgb: number[];
  branchCounts: {
    low24Black: number;
    material: number;
    spawn: number;
    scalarFallback: number;
  };
}

export interface MaterialPolygonPoint {
  x: number;
  y: number;
}

export interface MaterialComponentSelectionRecord {
  materialName: string;
  materialId: number | null;
  materialIndex: number;
  materialMin: number;
  materialMax: number;
  addPerlin: boolean;
  addPerlinScaleX: number;
  addPerlinScaleY: number;
  isRare: boolean;
  limitY: boolean;
  limitMinY: number;
  limitMaxY: number;
  rareUsePerlin: boolean;
  rareUseFbmPerlin: boolean;
  rareUsePolka: boolean;
  rareScaleX: number;
  rareScaleY: number;
  rareOffsetBySeed: boolean;
  rareOffsetX: number;
  rareOffsetY: number;
  rarePolkaRadiusLow: number;
  rarePolkaRadiusHigh: number;
  rarePolkaIsBoxed: boolean;
  rarePolkaProbability: number;
  rareRequiredMin: number;
  rareRequiredMax: number;
  isPolygon: boolean;
  polygon: MaterialPolygonPoint[];
}

export interface BiomeMaterialsConfiguration {
  biomeName: string;
  sourcePath: string;
  aggregateMaterialMin: number;
  aggregateMaterialMax: number;
  records: MaterialComponentSelectionRecord[];
  unresolvedMaterialNames: string[];
}

export type WangType2Resolution =
  | {
      status: "material";
      materialId: number;
      initialMaterialId: number;
      finalMaterialId: number;
      smoothedValue: number;
      terrainValue: number;
      usedBiomeMaterialsFallback: boolean;
    }
  | {
      status: "air" | "unsupported-smoothing" | "unresolved-biome-material";
      initialMaterialId: number;
      finalMaterialId: number;
      smoothedValue: number;
      terrainValue: number;
      usedBiomeMaterialsFallback: boolean;
      smoothingType?: number;
    };

function wrap(value: number, extent: number): number {
  const remainder = value % extent;
  return remainder < 0 ? remainder + extent : remainder;
}

function floorI32(value: number): number {
  const truncated = Math.trunc(value) | 0;
  return truncated > value ? (truncated - 1) | 0 : truncated;
}

function smoothCubic(value: number): number {
  const squared = fmul(value, value);
  return fmul(fsub(3, fmul(value, 2)), squared);
}

function interpolate(from: number, to: number, weight: number): number {
  return fadd(from, fmul(fsub(to, from), weight));
}

export function sampleWangFloatGridAtInteger(grid: WangFloatGrid, x: number, y: number): number {
  if (grid.width <= 0 || grid.height <= 0 || grid.pixels.length === 0) return 0;
  return grid.pixels[wrap(y, grid.height) * grid.width + wrap(x, grid.width)];
}

export function sampleWangFloatGridBilinear(grid: WangFloatGrid, x: number, y: number): number {
  const x0 = floorI32(x);
  const y0 = floorI32(y);
  const fractionX = f32(x - x0);
  const fractionY = f32(y - y0);
  const weightX = smoothCubic(fractionX);
  const bottom = interpolate(
    sampleWangFloatGridAtInteger(grid, x0, y0),
    sampleWangFloatGridAtInteger(grid, x0 + 1, y0),
    weightX,
  );
  const top = interpolate(
    sampleWangFloatGridAtInteger(grid, x0, y0 + 1),
    sampleWangFloatGridAtInteger(grid, x0 + 1, y0 + 1),
    weightX,
  );
  return interpolate(bottom, top, smoothCubic(fractionY));
}

export function sampleWangMaterialGridQuadratic(grid: WangMaterialGrid, x: number, y: number): number {
  if (grid.width <= 0 || grid.height <= 0 || grid.pixels.length === 0) return -1;
  let sampleX = floorI32(x);
  let sampleY = floorI32(y);
  if (!(0.5 > smoothCubic(f32(y - sampleY)))) sampleY += 1;
  if (!(0.5 > smoothCubic(f32(x - sampleX)))) sampleX += 1;
  return grid.pixels[wrap(sampleY, grid.height) * grid.width + wrap(sampleX, grid.width)] - 1;
}

function firstNativeWangMaterial(
  registry: NativeMaterialAppearanceRegistry,
  rgb: number,
): CanonicalMaterialDefinition | undefined {
  return registry.materialsAtWangRgb(rgb).reduce<CanonicalMaterialDefinition | undefined>(
    (selected, material) => !selected || material.initial_id < selected.initial_id ? material : selected,
    undefined,
  );
}

function grayscaleValue(red: number, green: number, blue: number): number {
  void red;
  const channelScale = f32(1 / 255);
  const blueScaled = fmul(f32(blue), channelScale);
  const greenScaled = fmul(f32(green), channelScale);
  return fdiv(fadd(fadd(greenScaled, blueScaled), blueScaled), 3);
}

function majorityVoteFirstTie(values: readonly number[]): number {
  const counts = new Map<number, number>();
  let result = 0;
  let bestCount = -1;
  for (const value of values) {
    if (value === 0) continue;
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (bestCount < count) {
      result = value;
      bestCount = count;
    }
  }
  return result;
}

/** Exact flag-one WangImage_ProcessMaterialBuffer semantics for Telescope's cropped RGB buffer. */
export function processWangMaterialBuffer(
  buffer: Uint8Array,
  sourceWidth: number,
  visibleHeight: number,
  registry: NativeMaterialAppearanceRegistry,
  sourceRowOffset = 4,
  isSpawnRgb?: (rgb: number) => boolean,
): ProcessedWangMaterialBuffer {
  if (sourceWidth <= 0 || visibleHeight <= 0) throw new Error("Wang grid dimensions must be positive");
  if (buffer.length < sourceWidth * (visibleHeight + sourceRowOffset) * 3) {
    throw new Error("Wang RGB buffer does not contain its declared visible extent");
  }
  const count = sourceWidth * visibleHeight;
  const floatPixels = new Float32Array(count);
  const materialPixels = new Uint16Array(count);
  const directMaterialIds = new Set<number>();
  const spawnRgb = new Set<number>();
  const scalarFallbackRgb = new Set<number>();
  const branchCounts = { low24Black: 0, material: 0, spawn: 0, scalarFallback: 0 };
  let materialGridAllocated = false;

  for (let y = 0; y < visibleHeight; y += 1) {
    for (let x = 0; x < sourceWidth; x += 1) {
      const outputIndex = y * sourceWidth + x;
      const sourceOffset = ((y + sourceRowOffset) * sourceWidth + x) * 3;
      const red = buffer[sourceOffset];
      const green = buffer[sourceOffset + 1];
      const blue = buffer[sourceOffset + 2];
      const rgb = (red << 16) | (green << 8) | blue;
      if (rgb === 0) {
        branchCounts.low24Black += 1;
        continue;
      }
      if (rgb === 0xffffff) {
        floatPixels[outputIndex] = grayscaleValue(red, green, blue);
        scalarFallbackRgb.add(rgb);
        branchCounts.scalarFallback += 1;
        continue;
      }

      // CellFactory gives material ID zero (air) priority at its canonical Wang RGB.
      // Telescope Wang sheets currently expose the native packed air word as
      // 0x420000, while decoded PixelScene PNGs expose authored RGB #000042.
      // Both represent CellData air (native material id zero).
      const materialId = rgb === 0x420000 || rgb === 0x000042
        ? 0
        : firstNativeWangMaterial(registry, rgb)?.initial_id;
      if (materialId !== undefined && materialId >= 0 && materialId <= 0xfffe) {
        const stored = materialId + 1;
        materialGridAllocated = true;
        materialPixels[outputIndex] = stored;
        floatPixels[outputIndex] = stored === 1 ? -1 : 1;
        directMaterialIds.add(materialId);
        branchCounts.material += 1;
        continue;
      }

      if (isSpawnRgb?.(rgb)) {
        spawnRgb.add(rgb);
        branchCounts.spawn += 1;
        continue;
      }
      scalarFallbackRgb.add(rgb);
      branchCounts.scalarFallback += 1;
      floatPixels[outputIndex] = grayscaleValue(red, green, blue);
    }
  }

  if (materialGridAllocated) {
    const propagated = materialPixels.slice();
    for (let y = 0; y < visibleHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const index = y * sourceWidth + x;
        if (materialPixels[index] !== 0 || floatPixels[index] !== 0) continue;
        const selected = majorityVoteFirstTie([
          materialPixels[y * sourceWidth + wrap(x - 1, sourceWidth)],
          materialPixels[y * sourceWidth + wrap(x + 1, sourceWidth)],
          materialPixels[wrap(y - 1, visibleHeight) * sourceWidth + x],
          materialPixels[wrap(y + 1, visibleHeight) * sourceWidth + x],
        ]);
        if (selected !== 0) propagated[index] = selected;
      }
    }
    materialPixels.set(propagated);
  }

  return {
    floatGrid: { width: sourceWidth, height: visibleHeight, pixels: floatPixels },
    materialGrid: { width: materialGridAllocated ? sourceWidth : 0, height: materialGridAllocated ? visibleHeight : 0, pixels: materialGridAllocated ? materialPixels : new Uint16Array() },
    directMaterialIds: Array.from(directMaterialIds).sort((left, right) => left - right),
    spawnRgb: Array.from(spawnRgb).sort((left, right) => left - right),
    scalarFallbackRgb: Array.from(scalarFallbackRgb).sort((left, right) => left - right),
    branchCounts,
  };
}

export function transformWangWorldCoordinate(
  worldX: number,
  worldY: number,
  wangOffsetX: number,
  wangOffsetY: number,
  noiseAmplitude: number,
): { x: number; y: number } {
  const adjustedY = wangOffsetY + worldY;
  const adjustedX = wangOffsetX + worldX;
  const scaledX = f32((adjustedX + 0.5) * 0.1);
  const scaledY = f32((adjustedY + 0.5) * 0.1);
  if (noiseAmplitude <= 0) return { x: scaledX, y: scaledY };

  const floorX = floorI32(scaledX);
  const floorY = floorI32(scaledY);
  const fractionX = f32(scaledX - floorX);
  const fractionY = f32(scaledY - floorY);
  const simplex = simplexNoise1234(f32(adjustedX * 0.13715), f32(adjustedY * 0.13717));
  const modulation = fadd(fmul(simplex, 0.45), 0.1);
  const perlinScale = f32(0.1111111119389534);
  const gradient = wangGradientNoise2d(f32(adjustedY * perlinScale), f32(adjustedX * perlinScale));
  let yFactor = fsub(1, modulation);
  yFactor = fmul(yFactor, 0.33);
  yFactor = fadd(yFactor, 0.111);
  yFactor = fmul(yFactor, noiseAmplitude);
  const yNoise = fmul(gradient, yFactor);
  const value = wangValueNoise2d(f32(adjustedX * perlinScale), f32(adjustedY * perlinScale));
  const xNoise = fmul(value, fmul(modulation, noiseAmplitude));
  return { x: fadd(fadd(xNoise, fractionX), f32(floorX)), y: fadd(f32(floorY), fadd(yNoise, fractionY)) };
}

export function sampleWangBaseNoise(worldX: number, worldY: number, wangValue: number): number {
  const value = wangValueNoise2d(f32(worldX * 0.035), f32(worldY * 0.07));
  const warp = fmul(value, 15.5);
  const simplexY = fmul(fadd(f32(worldY), warp), 0.0489275);
  const simplexX = fmul(fadd(f32(worldX), warp), 0.0489275);
  const simplex = simplexNoise1234(simplexX, simplexY);
  let modulation = fmul(fsub(wangValue, 0.5), 0.5);
  modulation = fmul(modulation, modulation);
  modulation = fmul(modulation, 5.35);
  modulation = fmul(modulation, 0.95);
  const candidate = fadd(fmul(simplex, modulation), wangValue);
  return 0.5 > candidate ? 0.5 : candidate;
}

function safeModulo512(value: number): number {
  return wrap(value | 0, 512);
}

export function pointInPolygonExact(point: MaterialPolygonPoint, vertices: readonly MaterialPolygonPoint[]): boolean {
  if (vertices.length === 0) return false;
  let previous = vertices[vertices.length - 1];
  let previousYAtOrAbove = previous.y >= point.y;
  let inside = false;
  for (const current of vertices) {
    const currentYAtOrAbove = current.y >= point.y;
    if (previousYAtOrAbove !== currentYAtOrAbove) {
      const previousXAtOrRight = previous.x >= point.x;
      const currentXAtOrRight = current.x >= point.x;
      let crossesRightwardRay: boolean;
      if (previousXAtOrRight === currentXAtOrRight) {
        crossesRightwardRay = previousXAtOrRight;
      } else {
        const dx = fsub(previous.x, current.x);
        const denominator = fsub(previous.y, current.y);
        const dyToPoint = fsub(current.y, point.y);
        const intersectionX = fsub(current.x, fdiv(fmul(dx, dyToPoint), denominator));
        crossesRightwardRay = intersectionX >= point.x;
      }
      if (crossesRightwardRay) inside = !inside;
    }
    previous = current;
    previousYAtOrAbove = currentYAtOrAbove;
  }
  return inside;
}

export function selectBiomeMaterialAtTerrainValue(
  configuration: BiomeMaterialsConfiguration,
  worldX: number,
  worldY: number,
  terrainValue: number,
  worldSeed: number,
): number | null {
  if (configuration.aggregateMaterialMin > terrainValue || terrainValue > configuration.aggregateMaterialMax) return null;
  for (const record of configuration.records) {
    if (record.limitY && (record.limitMinY > worldY || worldY > record.limitMaxY)) continue;
    if (record.isPolygon) {
      const point = { x: fmul(f32(safeModulo512(worldX)), 1 / 512), y: fmul(f32(safeModulo512(worldY)), 1 / 512) };
      if (!pointInPolygonExact(point, record.polygon)) continue;
    }
    if (record.materialId === null) continue;
    let adjustedValue = terrainValue;
    if (record.addPerlin) {
      const simplexX = fmul(f32(worldX | 0), record.addPerlinScaleX);
      const simplexY = fmul(f32(worldY | 0), record.addPerlinScaleY);
      adjustedValue = fadd(f32(simplexNoiseEvaluate(simplexX, simplexY)), terrainValue);
    }
    if (!(adjustedValue >= record.materialMin && adjustedValue < record.materialMax)) continue;
    if (!record.isRare) return record.materialId;

    let rareX = fadd(record.rareOffsetX, fmul(f32(worldX | 0), record.rareScaleX));
    let rareY = fadd(record.rareOffsetY, fmul(f32(worldY | 0), record.rareScaleY));
    if (record.rareOffsetBySeed) {
      const unsignedSeed = worldSeed >>> 0;
      const seedScaleX = (1 + Number(0x021a34d536e32n) / 2 ** 52) * 2 ** -16;
      const seedScaleY = (1 + Number(0x0a4d3860fd4277n) / 2 ** 52) * 2 ** -16;
      rareX = fadd(f32(unsignedSeed * seedScaleX), rareX);
      rareY = fadd(f32(unsignedSeed * seedScaleY), rareY);
    }
    if (record.rareUsePerlin) {
      const rareNoise = record.rareUseFbmPerlin ? fbmNoise4Octaves(rareX, rareY) : f32(simplexNoiseEvaluate(rareX, rareY));
      if (record.rareRequiredMin >= rareNoise || rareNoise > record.rareRequiredMax) continue;
    }
    if (record.rareUsePolka) {
      const polka = f32(polkaDotNoise(rareX, rareY, record.rarePolkaRadiusLow, record.rarePolkaRadiusHigh, record.rarePolkaIsBoxed, record.rarePolkaProbability));
      if (record.rareRequiredMin >= polka || polka > record.rareRequiredMax) continue;
    }
    return record.materialId;
  }
  return null;
}

export function resolveWangType2Material(
  processed: ProcessedWangMaterialBuffer,
  configuration: BiomeMaterialsConfiguration,
  registry: NativeMaterialAppearanceRegistry,
  worldSeed: number,
  worldX: number,
  worldY: number,
  wangOffsetX: number,
  wangOffsetY: number,
): WangType2Resolution {
  let threshold = 0.5;
  const clean = transformWangWorldCoordinate(worldX, worldY, wangOffsetX, wangOffsetY, 0);
  const initialMaterialId = sampleWangMaterialGridQuadratic(processed.materialGrid, clean.x, clean.y);
  let noiseAmplitude = 1;
  if (initialMaterialId > 0) {
    const material = registry.materialAtInitialId(initialMaterialId) as (CanonicalMaterialDefinition & {
      wang_noise_percent?: number;
      wang_curvature?: number;
      wang_noise_type?: number;
    }) | undefined;
    if (!material) {
      return { status: "unresolved-biome-material", initialMaterialId, finalMaterialId: -1, smoothedValue: 0, terrainValue: 0, usedBiomeMaterialsFallback: false };
    }
    noiseAmplitude = material.wang_noise_percent ?? 1;
    threshold = material.wang_curvature ?? 0.5;
    const smoothingType = material.wang_noise_type ?? 0;
    if (smoothingType !== 0) {
      return { status: "unsupported-smoothing", smoothingType, initialMaterialId, finalMaterialId: -1, smoothedValue: 0, terrainValue: 0, usedBiomeMaterialsFallback: false };
    }
  }

  const noisy = transformWangWorldCoordinate(worldX, worldY, wangOffsetX, wangOffsetY, noiseAmplitude);
  const smoothedValue = sampleWangFloatGridBilinear(processed.floatGrid, noisy.x, noisy.y);
  if (!(smoothedValue >= threshold)) {
    return { status: "air", initialMaterialId, finalMaterialId: -1, smoothedValue, terrainValue: 0, usedBiomeMaterialsFallback: false };
  }
  const finalMaterialId = sampleWangMaterialGridQuadratic(processed.materialGrid, noisy.x, noisy.y);
  if (finalMaterialId > 0) {
    return { status: "material", materialId: finalMaterialId, initialMaterialId, finalMaterialId, smoothedValue, terrainValue: 0, usedBiomeMaterialsFallback: false };
  }
  const terrainValue = sampleWangBaseNoise(worldX, worldY, smoothedValue);
  const selected = selectBiomeMaterialAtTerrainValue(configuration, Math.round(worldX), Math.round(worldY), terrainValue, worldSeed);
  if (selected === null) {
    // Native selector 0x0086D2A0 returns a null CellData* when no ordered
    // MaterialComponent qualifies. The type-2 resolver completes normally and
    // publishes material 0 (no cell); this is air, not a missing definition.
    return { status: "air", initialMaterialId, finalMaterialId, smoothedValue, terrainValue, usedBiomeMaterialsFallback: true };
  }
  return { status: "material", materialId: selected, initialMaterialId, finalMaterialId, smoothedValue, terrainValue, usedBiomeMaterialsFallback: true };
}
