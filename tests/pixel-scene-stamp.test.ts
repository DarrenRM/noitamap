import { describe, expect, it } from "vitest";

import {
  type CanonicalMaterialDefinition,
  NativeMaterialAppearanceRegistry,
} from "../src/terrain/material-appearance";
import {
  compilePixelSceneStamp,
  resolvePixelSceneStampAt,
  samplePixelSceneArtwork,
} from "../src/terrain/pixel-scene-stamp";
import type { BiomeMaterialsConfiguration, ProcessedWangMaterialBuffer } from "../src/terrain/wang-type2";

function material(id: string, initialId: number, wangRgb: number): CanonicalMaterialDefinition {
  return {
    id,
    initial_id: initialId,
    wang_color: `ff${wangRgb.toString(16).padStart(6, "0")}`,
    wang_noise_percent: 0,
    wang_curvature: 0.5,
    wang_noise_type: 0,
    graphics: { texture_file: "", color: "ffffffff", randomize_colors: false },
  };
}

function pixel(red: number, green: number, blue: number, alpha = 255): Uint8Array {
  return new Uint8Array([red, green, blue, alpha]);
}

function compile(
  rgba: Uint8Array,
  registry: NativeMaterialAppearanceRegistry,
  variantKey = "biome=rainforest",
) {
  return compilePixelSceneStamp({
    key: "rainforest/test",
    name: "test",
    x: 100,
    y: 200,
    width: 1,
    height: 1,
    variantKey,
    rgba,
  }, registry);
}

const emptyConfiguration: BiomeMaterialsConfiguration = {
  biomeName: "rainforest",
  sourcePath: "test",
  aggregateMaterialMin: 0,
  aggregateMaterialMax: 2,
  records: [],
  unresolvedMaterialNames: [],
};

describe("native PixelScene terrain stamping", () => {
  const definitions = [
    material("direct", 4, 0x040506),
    material("generated", 7, 0x070809),
    material("fallback", 8, 0x08090a),
  ];
  const registry = new NativeMaterialAppearanceRegistry(definitions, new Map());

  it("preserves black, clears explicit authored air, and stamps direct material identities", () => {
    expect(resolvePixelSceneStampAt(compile(pixel(0, 0, 0), registry), 1, 100, 200, null)).toEqual({
      status: "preserve",
    });
    expect(resolvePixelSceneStampAt(compile(pixel(0, 0, 0x42), registry), 1, 100, 200, null)).toEqual({
      status: "air",
    });
    expect(resolvePixelSceneStampAt(compile(pixel(4, 5, 6), registry), 1, 100, 200, null)).toEqual({
      status: "material",
      materialId: 4,
      source: "direct",
    });
  });

  it("applies seeded color_material substitutions before material lookup", () => {
    const stamp = compile(pixel(0xf0, 0xbb, 0xee), registry, "f0bbee=040506&biome=rainforest");
    expect(resolvePixelSceneStampAt(stamp, 1, 100, 200, null)).toEqual({
      status: "material",
      materialId: 4,
      source: "direct",
    });
  });

  it("retains globally registered spawn colors instead of treating them as grayscale terrain", () => {
    const stamp = compilePixelSceneStamp({
      key: "general/spawn",
      name: "spawn",
      x: 100,
      y: 200,
      width: 1,
      height: 1,
      rgba: pixel(0x00, 0xff, 0xff),
    }, registry, (_biome, rgb) => rgb === 0x00ffff);
    expect(stamp.processed.branchCounts.spawn).toBe(1);
    expect(resolvePixelSceneStampAt(stamp, 1, 100, 200, null)).toEqual({ status: "preserve" });
  });

  it("routes grayscale structure pixels through the selected biome's generated Wang grid", () => {
    const stamp = compile(pixel(255, 255, 255), registry);
    const generated: ProcessedWangMaterialBuffer = {
      floatGrid: { width: 1, height: 1, pixels: new Float32Array([1]) },
      materialGrid: { width: 1, height: 1, pixels: new Uint16Array([8]) },
      directMaterialIds: [7],
      spawnRgb: [],
      scalarFallbackRgb: [],
      branchCounts: { low24Black: 0, material: 1, spawn: 0, scalarFallback: 0 },
    };
    expect(resolvePixelSceneStampAt(stamp, 1, 100, 200, {
      processed: generated,
      biomeMaterials: emptyConfiguration,
      wangOffsetX: 0,
      wangOffsetY: 0,
    })).toEqual({ status: "material", materialId: 7, source: "generated-wang" });
  });

  it("uses BiomeMaterials only after a generated-Wang miss and preserves on a null selection", () => {
    const stamp = compile(pixel(255, 255, 255), registry);
    const generated: ProcessedWangMaterialBuffer = {
      floatGrid: { width: 1, height: 1, pixels: new Float32Array([1]) },
      materialGrid: { width: 1, height: 1, pixels: new Uint16Array([0]) },
      directMaterialIds: [],
      spawnRgb: [],
      scalarFallbackRgb: [],
      branchCounts: { low24Black: 0, material: 0, spawn: 0, scalarFallback: 1 },
    };
    const view = { processed: generated, biomeMaterials: emptyConfiguration, wangOffsetX: 0, wangOffsetY: 0 };
    expect(resolvePixelSceneStampAt(stamp, 1, 100, 200, view)).toEqual({ status: "preserve" });

    const configuration: BiomeMaterialsConfiguration = {
      ...emptyConfiguration,
      records: [{
        materialName: "fallback", materialId: 8, materialIndex: 0,
        materialMin: 0, materialMax: 2, addPerlin: false, addPerlinScaleX: 1, addPerlinScaleY: 1,
        isRare: false, limitY: false, limitMinY: 0, limitMaxY: 0,
        rareUsePerlin: false, rareUseFbmPerlin: false, rareUsePolka: false,
        rareScaleX: 1, rareScaleY: 1, rareOffsetBySeed: false, rareOffsetX: 0, rareOffsetY: 0,
        rarePolkaRadiusLow: 0, rarePolkaRadiusHigh: 1, rarePolkaIsBoxed: false,
        rarePolkaProbability: 0, rareRequiredMin: 0, rareRequiredMax: 1,
        isPolygon: false, polygon: [],
      }],
    };
    expect(resolvePixelSceneStampAt(stamp, 1, 100, 200, { ...view, biomeMaterials: configuration })).toEqual({
      status: "material",
      materialId: 8,
      source: "biome-material",
    });
  });

  it("samples authored background and visual pixels in world coordinates without flattening alpha", () => {
    const stamp = compilePixelSceneStamp({
      key: "rainforest/art",
      name: "art",
      x: -5,
      y: 9,
      width: 1,
      height: 1,
      rgba: pixel(4, 5, 6),
      background: { width: 1, height: 1, rgba: pixel(0x11, 0x22, 0x33, 0x44) },
      visual: { width: 1, height: 1, rgba: pixel(0xaa, 0xbb, 0xcc, 0xdd) },
    }, registry);
    expect(samplePixelSceneArtwork(stamp, "background", -5, 9)).toBe(0x44332211);
    expect(samplePixelSceneArtwork(stamp, "visual", -5, 9)).toBe(0xddccbbaa);
    expect(samplePixelSceneArtwork(stamp, "visual", -4, 9)).toBeNull();
  });
});
