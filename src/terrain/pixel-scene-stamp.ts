import type { NativeMaterialAppearanceRegistry } from "./material-appearance";
import {
  processWangMaterialBuffer,
  sampleWangBaseNoise,
  sampleWangMaterialGridQuadratic,
  selectBiomeMaterialAtTerrainValue,
  transformWangWorldCoordinate,
  type BiomeMaterialsConfiguration,
  type ProcessedWangMaterialBuffer,
} from "./wang-type2";

export interface PixelSceneStampInput {
  key: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  variantKey?: string;
  skipEdgeTextures?: boolean;
  rgba: Uint8Array | Uint8ClampedArray;
  background?: PixelSceneArtworkLayer | null;
  visual?: PixelSceneArtworkLayer | null;
}

export interface PixelSceneArtworkLayer {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

export interface CompiledPixelSceneStamp {
  key: string;
  name: string;
  biomeName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceRgba: Uint8Array;
  processed: ProcessedWangMaterialBuffer;
  background: PixelSceneArtworkLayer | null;
  visual: PixelSceneArtworkLayer | null;
  skipEdgeTextures: boolean;
}

export interface PixelSceneGeneratedWangView {
  processed: ProcessedWangMaterialBuffer;
  biomeMaterials: BiomeMaterialsConfiguration | null;
  wangOffsetX: number;
  wangOffsetY: number;
}

export type PixelSceneStampResolution =
  | { status: "preserve" }
  | { status: "air" }
  | { status: "material"; materialId: number; source: "direct" | "generated-wang" | "biome-material" };

function parseBiomeName(key: string, variantKey?: string): string {
  for (const part of (variantKey ?? "").split("&")) {
    if (part.startsWith("biome=") && part.length > "biome=".length) {
      return part.slice("biome=".length);
    }
  }
  const slash = key.indexOf("/");
  return slash < 0 ? key : key.slice(0, slash);
}

/**
 * Apply LuaAPI_LoadPixelScene color_material substitutions before the Wang
 * material buffer is processed. Telescope records the already-seeded target
 * Wang RGB in variantKey as `source=target`.
 */
function applyColorMaterialOverrides(
  source: Uint8Array | Uint8ClampedArray,
  variantKey?: string,
): Uint8Array {
  const output = new Uint8Array(source);
  const replacements = new Map<number, number>();
  for (const part of (variantKey ?? "").split("&")) {
    const equal = part.indexOf("=");
    if (equal <= 0 || part.startsWith("biome=")) continue;
    const from = Number.parseInt(part.slice(0, equal), 16);
    const to = Number.parseInt(part.slice(equal + 1), 16);
    if (Number.isFinite(from) && Number.isFinite(to)) replacements.set(from & 0xffffff, to & 0xffffff);
  }
  if (replacements.size === 0) return output;
  for (let offset = 0; offset + 3 < output.length; offset += 4) {
    const rgb = (output[offset] << 16) | (output[offset + 1] << 8) | output[offset + 2];
    const replacement = replacements.get(rgb);
    if (replacement === undefined) continue;
    output[offset] = replacement >>> 16;
    output[offset + 1] = replacement >>> 8;
    output[offset + 2] = replacement;
  }
  return output;
}

/** Compile the authored material image through native Wang buffer semantics. */
export function compilePixelSceneStamp(
  input: PixelSceneStampInput,
  registry: NativeMaterialAppearanceRegistry,
  isSpawnRgb?: (biomeName: string, rgb: number) => boolean,
): CompiledPixelSceneStamp {
  if (input.width <= 0 || input.height <= 0 || input.rgba.length < input.width * input.height * 4) {
    throw new Error(`[PixelSceneStamp] invalid material image extent for ${input.key}`);
  }
  const biomeName = parseBiomeName(input.key, input.variantKey);
  const sourceRgba = applyColorMaterialOverrides(input.rgba, input.variantKey);
  const rgb = new Uint8Array(input.width * input.height * 3);
  for (let sourceOffset = 0, targetOffset = 0; targetOffset < rgb.length; sourceOffset += 4, targetOffset += 3) {
    rgb[targetOffset] = sourceRgba[sourceOffset];
    rgb[targetOffset + 1] = sourceRgba[sourceOffset + 1];
    rgb[targetOffset + 2] = sourceRgba[sourceOffset + 2];
  }
  return {
    key: input.key,
    name: input.name,
    biomeName,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    sourceRgba,
    processed: processWangMaterialBuffer(
      rgb,
      input.width,
      input.height,
      registry,
      0,
      (color) => isSpawnRgb?.(biomeName, color) ?? false,
    ),
    background: input.background ?? null,
    visual: input.visual ?? null,
    skipEdgeTextures: input.skipEdgeTextures ?? false,
  };
}

/** Sample authored RGBA as the renderer's AABBGGRR cell color word. */
export function samplePixelSceneArtwork(
  stamp: CompiledPixelSceneStamp,
  layer: "background" | "visual",
  worldX: number,
  worldY: number,
): number | null {
  const artwork = stamp[layer];
  if (!artwork || artwork.width <= 0 || artwork.height <= 0) return null;
  const localX = (worldX | 0) - stamp.x;
  const localY = (worldY | 0) - stamp.y;
  if (localX < 0 || localY < 0 || localX >= artwork.width || localY >= artwork.height) return null;
  const offset = (localY * artwork.width + localX) * 4;
  if (offset + 3 >= artwork.rgba.length || artwork.rgba[offset + 3] === 0) return null;
  return (
    (artwork.rgba[offset + 3] << 24) |
    (artwork.rgba[offset + 2] << 16) |
    (artwork.rgba[offset + 1] << 8) |
    artwork.rgba[offset]
  ) >>> 0;
}

/**
 * Resolve one PixelScene material pixel using the closed V2
 * PixelScene_LoadTerrainStrips -> WangWorld_ProcessChunkTiles ->
 * PixelScene_GetStatus route. Black/unmarked pixels preserve existing terrain;
 * explicit air clears it; material pixels replace it.
 */
export function resolvePixelSceneStampAt(
  stamp: CompiledPixelSceneStamp,
  worldSeed: number,
  worldX: number,
  worldY: number,
  generated: PixelSceneGeneratedWangView | null,
): PixelSceneStampResolution {
  const localX = (worldX | 0) - stamp.x;
  const localY = (worldY | 0) - stamp.y;
  if (localX < 0 || localY < 0 || localX >= stamp.width || localY >= stamp.height) {
    return { status: "preserve" };
  }
  const index = localY * stamp.width + localX;
  const sourceOffset = index * 4;
  const sourceRgb =
    (stamp.sourceRgba[sourceOffset] << 16) |
    (stamp.sourceRgba[sourceOffset + 1] << 8) |
    stamp.sourceRgba[sourceOffset + 2];
  // Native black pixels leave both Wang products zero and preserve the
  // destination when clean_area_before is false (the normal Lua route).
  if (sourceRgb === 0) return { status: "preserve" };

  const storedMaterial = stamp.processed.materialGrid.pixels[index] ?? 0;
  const wangValue = stamp.processed.floatGrid.pixels[index] ?? 0;
  if (wangValue < 0 || storedMaterial === 1) return { status: "air" };
  if (storedMaterial > 1) {
    return { status: "material", materialId: storedMaterial - 1, source: "direct" };
  }

  if (!(wangValue > 0.5) || !generated) return { status: "preserve" };
  const coordinate = transformWangWorldCoordinate(
    worldX,
    worldY,
    generated.wangOffsetX,
    generated.wangOffsetY,
    1,
  );
  const generatedMaterialId = sampleWangMaterialGridQuadratic(
    generated.processed.materialGrid,
    coordinate.x,
    coordinate.y,
  );
  if (generatedMaterialId > 0) {
    return { status: "material", materialId: generatedMaterialId, source: "generated-wang" };
  }
  if (!generated.biomeMaterials) return { status: "preserve" };
  const terrainValue = sampleWangBaseNoise(worldX, worldY, wangValue);
  const fallbackMaterialId = selectBiomeMaterialAtTerrainValue(
    generated.biomeMaterials,
    worldX,
    worldY,
    terrainValue,
    worldSeed,
  );
  // A null BiomeMaterials result publishes no new cell here. Unlike the base
  // terrain route, PixelScene_GetStatus therefore preserves the destination.
  return fallbackMaterialId === null
    ? { status: "preserve" }
    : { status: "material", materialId: fallbackMaterialId, source: "biome-material" };
}
