import { describe, expect, it } from "vitest";

import { parseBiomeMaterialsConfiguration } from "../src/terrain/biome-material-config";
import {
  type CanonicalMaterialDefinition,
  NativeMaterialAppearanceRegistry,
} from "../src/terrain/material-appearance";
import {
  processWangMaterialBuffer,
  resolveWangType2Material,
  sampleWangBaseNoise,
  sampleWangFloatGridBilinear,
  sampleWangMaterialGridQuadratic,
  transformWangWorldCoordinate,
  type BiomeMaterialsConfiguration,
} from "../src/terrain/wang-type2";

const bitsBuffer = new ArrayBuffer(4);
const bitsView = new DataView(bitsBuffer);
const bits = (value: number): string => {
  bitsView.setFloat32(0, value, true);
  return bitsView.getUint32(0, true).toString(16).padStart(8, "0");
};

function material(id: string, initialId: number, wangRgb: number, noiseType = 0): CanonicalMaterialDefinition {
  return {
    id,
    initial_id: initialId,
    wang_color: `ff${wangRgb.toString(16).padStart(6, "0")}`,
    wang_noise_percent: 0,
    wang_curvature: 0.5,
    wang_noise_type: noiseType,
    graphics: { texture_file: "", color: "ffffffff", randomize_colors: false },
  };
}

describe("native Wang type-2 terrain resolver", () => {
  it("matches exact coordinate-transform and base-noise evidence vectors", () => {
    const clean = transformWangWorldCoordinate(123.25, -456.75, 17920, 7168, 0);
    expect(bits(clean.x)).toBe("44e18c00");
    expect(bits(clean.y)).toBe("4427cb33");
    const noisy = transformWangWorldCoordinate(123.25, -456.75, 17920, 7168, 1);
    expect(bits(noisy.x)).toBe("44e18629");
    expect(bits(noisy.y)).toBe("4427cd77");
    expect(bits(sampleWangBaseNoise(123.25, -456.75, 0.75))).toBe("3f4133d6");
  });

  it("uses cubic, wrapped float sampling and quadratic material probes", () => {
    const floats = { width: 2, height: 2, pixels: new Float32Array([0, 1, 2, 3]) };
    expect(sampleWangFloatGridBilinear(floats, 0, 0)).toBe(0);
    expect(sampleWangFloatGridBilinear(floats, 1, 1)).toBe(3);
    const materials = { width: 2, height: 2, pixels: new Uint16Array([1, 2, 3, 4]) };
    expect(sampleWangMaterialGridQuadratic(materials, 0.49, 0.49)).toBe(0);
    expect(sampleWangMaterialGridQuadratic(materials, 0.51, 0.49)).toBe(1);
    expect(sampleWangMaterialGridQuadratic(materials, -0.49, -0.49)).toBe(0);
    expect(sampleWangMaterialGridQuadratic(materials, -0.51, -0.51)).toBe(3);
  });

  it("processes material, spawn, scalar, air, and wrapped-majority branches", () => {
    const registry = new NativeMaterialAppearanceRegistry([material("rock", 4, 0x040506)], new Map());
    const rgb = [
      0x040506, 0x000000, 0x040506,
      0x070809, 0x0c8040, 0x420000,
      0x040506, 0x000000, 0x040506,
    ];
    const buffer = new Uint8Array(rgb.length * 3);
    rgb.forEach((color, index) => {
      buffer[index * 3] = color >>> 16;
      buffer[index * 3 + 1] = color >>> 8;
      buffer[index * 3 + 2] = color;
    });
    const processed = processWangMaterialBuffer(buffer, 3, 3, registry, 0, (color) => color === 0x070809);
    expect(Array.from(processed.materialGrid.pixels)).toEqual([5, 5, 5, 5, 0, 1, 5, 5, 5]);
    expect(processed.floatGrid.pixels[0]).toBe(1);
    expect(processed.floatGrid.pixels[3]).toBe(0);
    expect(processed.floatGrid.pixels[4]).toBeGreaterThan(0);
    expect(processed.floatGrid.pixels[5]).toBe(-1);
    expect(processed.directMaterialIds).toEqual([0, 4]);
    expect(processed.spawnRgb).toEqual([0x070809]);
    expect(processed.scalarFallbackRgb).toEqual([0x0c8040]);
    expect(processed.branchCounts).toEqual({ low24Black: 2, material: 5, spawn: 1, scalarFallback: 1 });
  });

  it("parses, stable-sorts, resolves, and aggregates native MaterialComponents", () => {
    const definitions = [material("low", 2, 0x111111), material("high", 3, 0x222222)];
    const xml = `<Biome><Materials>
      <MaterialComponent material_name="high" material_index="10" material_min="0.6" material_max="1.2"></MaterialComponent>
      <MaterialComponent material_name="low" material_index="5" material_min="0.2" material_max="0.7" rare_use_polka="0"></MaterialComponent>
      <MaterialComponent material_name="missing" material_index="11"></MaterialComponent>
    </Materials></Biome>`;
    const parsed = parseBiomeMaterialsConfiguration(xml, "test", "data/biome/test.xml", definitions);
    expect(parsed.records.map((record) => record.materialName)).toEqual(["low", "high", "missing"]);
    expect(parsed.records.map((record) => record.materialId)).toEqual([2, 3, null]);
    expect(bits(parsed.aggregateMaterialMin)).toBe(bits(Math.fround(0.2)));
    expect(bits(parsed.aggregateMaterialMax)).toBe(bits(Math.fround(1.2)));
    expect(parsed.records[0].rareScaleX).toBe(Math.fround(0.05));
    expect(parsed.unresolvedMaterialNames).toEqual(["missing"]);
  });

  it("returns direct material, fallback material, and explicit unsupported smoothing", () => {
    const definitions = [material("direct", 1, 0x010203), material("fallback", 2, 0x040506)];
    const registry = new NativeMaterialAppearanceRegistry(definitions, new Map());
    const configuration: BiomeMaterialsConfiguration = {
      biomeName: "test",
      sourcePath: "test",
      aggregateMaterialMin: 0,
      aggregateMaterialMax: 2,
      unresolvedMaterialNames: [],
      records: [{
        materialName: "fallback", materialId: 2, materialIndex: 10,
        materialMin: 0, materialMax: 2, addPerlin: false, addPerlinScaleX: 1, addPerlinScaleY: 1,
        isRare: false, limitY: false, limitMinY: 100, limitMaxY: 2048,
        rareUsePerlin: false, rareUseFbmPerlin: false, rareUsePolka: false,
        rareScaleX: 0.05, rareScaleY: 0.05, rareOffsetBySeed: false, rareOffsetX: 0, rareOffsetY: 0,
        rarePolkaRadiusLow: 0.2, rarePolkaRadiusHigh: 0.65, rarePolkaIsBoxed: true,
        rarePolkaProbability: 0.2, rareRequiredMin: 0.2, rareRequiredMax: 1,
        isPolygon: false, polygon: [],
      }],
    };
    const direct = {
      floatGrid: { width: 2, height: 2, pixels: new Float32Array([1, 1, 1, 1]) },
      materialGrid: { width: 2, height: 2, pixels: new Uint16Array([2, 2, 2, 2]) },
      directMaterialIds: [1], spawnRgb: [], scalarFallbackRgb: [],
      branchCounts: { low24Black: 0, material: 4, spawn: 0, scalarFallback: 0 },
    };
    expect(resolveWangType2Material(direct, configuration, registry, 0, 0, 0, 0, 0).status).toBe("material");
    const fallback = { ...direct, materialGrid: { width: 2, height: 2, pixels: new Uint16Array([1, 1, 1, 1]) } };
    const fallbackResult = resolveWangType2Material(fallback, configuration, registry, 0, 0, 0, 0, 0);
    expect(fallbackResult.status).toBe("material");
    if (fallbackResult.status === "material") expect(fallbackResult.materialId).toBe(2);

    const noQualifyingRecord = {
      ...configuration,
      aggregateMaterialMin: Math.fround(0),
      aggregateMaterialMax: Math.fround(2),
      records: configuration.records.map((record) => ({
        ...record,
        materialMin: Math.fround(1.5),
        materialMax: Math.fround(2),
      })),
    };
    expect(resolveWangType2Material(fallback, noQualifyingRecord, registry, 0, 0, 0, 0, 0)).toMatchObject({
      status: "air",
      usedBiomeMaterialsFallback: true,
    });

    definitions[0].wang_noise_type = 1;
    const unsupportedRegistry = new NativeMaterialAppearanceRegistry(definitions, new Map());
    expect(resolveWangType2Material(direct, configuration, unsupportedRegistry, 0, 0, 0, 0, 0)).toMatchObject({
      status: "unsupported-smoothing", smoothingType: 1,
    });
  });
});
