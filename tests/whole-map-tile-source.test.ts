import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TileLayer } from "../src/telescope/telescope-adapter";
import {
  type CanonicalMaterialDefinition,
  NativeMaterialAppearanceRegistry,
} from "../src/terrain/material-appearance";
import { compilePixelSceneStamp } from "../src/terrain/pixel-scene-stamp";
import { createWholeMapTerrainTileSource } from "../src/terrain/whole-map-tile-source";
import type { BiomeMaterialsConfiguration } from "../src/terrain/wang-type2";
import type { BiomeVegetationConfiguration } from "../src/terrain/vegetation";

class TileSourceStub {
  [key: string]: unknown;

  constructor(options: Record<string, unknown>) {
    Object.assign(this, options);
  }
}

interface CanvasStub {
  width: number;
  height: number;
  pixels?: Uint8ClampedArray;
  getContext(kind: string): {
    createImageData(
      width: number,
      height: number,
    ): { width: number; height: number; data: Uint8ClampedArray };
    putImageData(image: { data: Uint8ClampedArray }): void;
  } | null;
}

function createCanvasStub(): CanvasStub {
  const canvas: CanvasStub = {
    width: 0,
    height: 0,
    getContext(kind: string) {
      if (kind !== "2d") return null;
      return {
        createImageData: (width, height) => ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        }),
        putImageData: (image) => {
          canvas.pixels = image.data.slice();
        },
      };
    },
  };
  return canvas;
}

async function renderTile(
  tileSource: any,
  level: number,
  x: number,
  y: number,
): Promise<CanvasStub> {
  return new Promise((resolve, reject) => {
    tileSource.downloadTileStart({
      tile: { level, x, y },
      finish(canvas: CanvasStub, error: Error | null) {
        if (error) reject(error);
        else resolve(canvas);
      },
    });
  });
}

function makeLayer(width: number, height: number, rgb: number): TileLayer {
  const sourceRowOffset = 4;
  const buffer = new Uint8Array(width * (height + sourceRowOffset) * 3);
  for (let index = 0; index < width * (height + sourceRowOffset); index += 1) {
    buffer[index * 3] = rgb >>> 16;
    buffer[index * 3 + 1] = rgb >>> 8;
    buffer[index * 3 + 2] = rgb;
  }
  return {
    biomeName: "test",
    canvas: null as unknown as HTMLCanvasElement,
    correctedX: 0,
    correctedY: 14 * 512,
    w: width,
    h: height,
    buffer,
    width,
    height: height + sourceRowOffset,
    mapH: height,
    minX: 0,
    minY: 0,
    validChunks: null,
    xmax: width,
    ymax: height,
    tileSize: 1,
    tileIndices: new Uint16Array(),
    numHTiles: 1,
    numVTiles: 1,
    path: [],
    pixelScenesByPW: {},
  };
}

function materialDefinition(
  id: string,
  initialId: number,
  rgb: number,
  textureFile: string,
): CanonicalMaterialDefinition {
  return {
    id,
    initial_id: initialId,
    wang_color: `ff${rgb.toString(16).padStart(6, "0")}`,
    wang_noise_percent: 0,
    wang_curvature: 0.5,
    wang_noise_type: 0,
    graphics: {
      texture_file: textureFile,
      color: "ffffffff",
      randomize_colors: false,
    },
  };
}

describe("whole-map reconstructed tile source", () => {
  beforeEach(() => {
    vi.stubGlobal("OpenSeadragon", { TileSource: TileSourceStub });
    vi.stubGlobal("document", { createElement: () => createCanvasStub() });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("publishes admitted generated grass into the open cell above an exposed surface", async () => {
    const soil = materialDefinition("soil", 116, 0x040506, "soil.png");
    const grass = materialDefinition("grass", 158, 0x070809, "grass.png");
    const registry = new NativeMaterialAppearanceRegistry(
      [soil, grass],
      new Map([
        ["soil.png", { width: 1, height: 1, rgba: new Uint8Array([40, 40, 40, 255]) }],
        ["grass.png", { width: 1, height: 1, rgba: new Uint8Array([20, 220, 30, 255]) }],
      ]),
    );
    const layer = makeLayer(52, 2, 0);
    layer.correctedY = 0;
    for (let x = 0; x < layer.width; x += 1) {
      const offset = ((4 + 1) * layer.width + x) * 3;
      layer.buffer![offset] = 0x04;
      layer.buffer![offset + 1] = 0x05;
      layer.buffer![offset + 2] = 0x06;
    }
    const biomeMaterials: BiomeMaterialsConfiguration = {
      biomeName: "test",
      sourcePath: "test.xml",
      aggregateMaterialMin: 0,
      aggregateMaterialMax: 1,
      records: [],
      unresolvedMaterialNames: [],
    };
    const biomeVegetation: BiomeVegetationConfiguration = {
      biomeName: "test",
      sourcePath: "test.xml",
      unresolvedMaterialNames: [],
      components: [{
        sourceIndex: 0,
        isVisual: true,
        isGrass: true,
        isCeilingPlant: false,
        randSeed: 0,
        treeWidth: 1000,
        treeRadiusLow: 0.5,
        treeRadiusHigh: 0.5,
        treeProbability: 1,
        treeImageFile: "",
        treeMaterialName: "grass",
        treeMaterialId: 158,
        grassRequiresNeighbors: false,
        materialOnTopOfName: "soil",
        materialOnTopOfId: 116,
      }],
    };
    const result = createWholeMapTerrainTileSource([layer], registry, {
      worldSeed: 1,
      biomeMaterials: new Map([["test", biomeMaterials]]),
      biomeVegetation: new Map([["test", biomeVegetation]]),
      worldCenter: 0,
      parallelWorld: 0,
      verticalPlane: 0,
      worldWidthChunks: 1,
      biomeMap: {
        pixels: new Uint32Array([0x00112233]),
        width: 1,
        height: 1,
        colorToName: new Map([[0x112233, "test"]]),
      },
    });
    expect(result).not.toBeNull();
    const rendered = await renderTile(result!.tileSource, result!.tileSource.maxLevel, 0, 0);
    let grassPixels = 0;
    for (let offset = 0; offset < rendered.pixels!.length; offset += 4) {
      if (
        rendered.pixels![offset] === 20 &&
        rendered.pixels![offset + 1] === 220 &&
        rendered.pixels![offset + 2] === 30
      ) grassPixels += 1;
    }
    expect(grassPixels).toBeGreaterThan(0);
    expect(result!.coverage.grassOverlayCellsRendered).toBe(grassPixels);
    expect(result!.coverage.grassOverlayRuleSetsResolved).toBe(1);
  });

  it("renders deterministic native-coordinate material pixels across an uneven 512-cell seam", async () => {
    const material: CanonicalMaterialDefinition = {
      id: "test_material",
      initial_id: 4,
      wang_color: "ff040506",
      wang_noise_percent: 0,
      wang_curvature: 0.5,
      wang_noise_type: 0,
      graphics: {
        texture_file: "test.png",
        color: "ffffffff",
        randomize_colors: false,
      },
    };
    const texture = {
      width: 2,
      height: 2,
      rgba: new Uint8Array([
        1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255,
      ]),
    };
    const registry = new NativeMaterialAppearanceRegistry(
      [material],
      new Map([["test.png", texture]]),
    );
    const configuration: BiomeMaterialsConfiguration = {
      biomeName: "test",
      sourcePath: "test.xml",
      aggregateMaterialMin: 0,
      aggregateMaterialMax: 1,
      records: [],
      unresolvedMaterialNames: [],
    };
    const layers = [makeLayer(60, 2, 0x040506)];
    const options = {
      worldSeed: 123,
      biomeMaterials: new Map([["test", configuration]]),
      worldCenter: 0,
      parallelWorld: 0,
      verticalPlane: 0,
      worldWidthChunks: 70,
    };

    const first = createWholeMapTerrainTileSource(layers, registry, options);
    const second = createWholeMapTerrainTileSource(layers, registry, options);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.coverage).toMatchObject({
      directMaterialPixels: 120,
      low24BlackPixels: 0,
      spawnMarkerPixels: 0,
      scalarFallbackPixels: 0,
      processedInitialMaterialPixelsBySmoothingType: { "0": 120 },
      processedInitialMaterialsBySmoothingType: {
        "0": [
          {
            materialId: 4,
            materialName: "test_material",
            pixels: 120,
            biomeNames: ["test"],
          },
        ],
      },
      missingBiomeConfigurations: [],
      unresolvedBiomeMaterialNames: [],
    });

    const [left, right, leftAgain, rightAgain] = await Promise.all([
      renderTile(first!.tileSource, 10, 0, 0),
      renderTile(first!.tileSource, 10, 1, 0),
      renderTile(second!.tileSource, 10, 0, 0),
      renderTile(second!.tileSource, 10, 1, 0),
    ]);
    const leftFromSourceCache = await renderTile(first!.tileSource, 10, 0, 0);
    expect(left.width).toBe(512);
    expect(right.width).toBe(88);
    expect(left.height).toBe(20);
    expect(right.height).toBe(20);
    expect(left.pixels).toEqual(leftAgain.pixels);
    expect(right.pixels).toEqual(rightAgain.pixels);
    expect(leftFromSourceCache).toBe(left);

    const stitched = new Uint8ClampedArray(600 * 20 * 4);
    for (let y = 0; y < 20; y += 1) {
      stitched.set(
        left.pixels!.subarray(y * 512 * 4, (y + 1) * 512 * 4),
        y * 600 * 4,
      );
      stitched.set(
        right.pixels!.subarray(y * 88 * 4, (y + 1) * 88 * 4),
        (y * 600 + 512) * 4,
      );
    }
    for (let y = 0; y < 20; y += 1) {
      for (let x = 0; x < 600; x += 1) {
        const sampled = registry.sample(4, x, y);
        expect(sampled.status).toBe("sampled");
        if (sampled.status !== "sampled") continue;
        const offset = (y * 600 + x) * 4;
        expect(Array.from(stitched.subarray(offset, offset + 4))).toEqual([
          sampled.packedAabbggrr & 0xff,
          (sampled.packedAabbggrr >>> 8) & 0xff,
          (sampled.packedAabbggrr >>> 16) & 0xff,
          sampled.packedAabbggrr >>> 24,
        ]);
      }
    }
  });

  it("keeps the Wang offset fixed while sampling a horizontal parallel world at absolute coordinates", async () => {
    const material: CanonicalMaterialDefinition = {
      id: "parallel_material",
      initial_id: 4,
      wang_color: "ff040506",
      wang_noise_percent: 0,
      wang_curvature: 0.5,
      wang_noise_type: 0,
      graphics: {
        texture_file: "parallel.png",
        color: "ffffffff",
        randomize_colors: false,
      },
    };
    const texture = {
      width: 3,
      height: 1,
      rgba: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]),
    };
    const registry = new NativeMaterialAppearanceRegistry(
      [material],
      new Map([["parallel.png", texture]]),
    );
    const configuration: BiomeMaterialsConfiguration = {
      biomeName: "test",
      sourcePath: "test.xml",
      aggregateMaterialMin: 0,
      aggregateMaterialMax: 1,
      records: [],
      unresolvedMaterialNames: [],
    };
    // 512 Wang cells span 10 chunks, so the east-PW displacement wraps the
    // retained material grid exactly while remaining visible to world noise
    // and authored texture sampling.
    const result = createWholeMapTerrainTileSource(
      [makeLayer(512, 1, 0x040506)],
      registry,
      {
        worldSeed: 123,
        biomeMaterials: new Map([["test", configuration]]),
        worldCenter: 0,
        parallelWorld: 1,
        verticalPlane: 0,
        worldWidthChunks: 10,
      },
    );
    expect(result).not.toBeNull();
    expect(result!.originX).toBe(5120);
    const tile = await renderTile(result!.tileSource, 13, 0, 0);
    expect(Array.from(tile.pixels!.subarray(0, 4))).toEqual([70, 80, 90, 255]);
    expect(registry.sample(4, 5120, 0)).toMatchObject({
      status: "sampled",
      packedAabbggrr: 0xff5a5046,
    });
  });

  it("preserves PixelScene source order through the spatial index", async () => {
    const materials: CanonicalMaterialDefinition[] = [
      {
        id: "base",
        initial_id: 4,
        wang_color: "ff040506",
        wang_noise_percent: 0,
        wang_curvature: 0.5,
        wang_noise_type: 0,
        graphics: {
          texture_file: "base.png",
          color: "ffffffff",
          randomize_colors: false,
        },
      },
      {
        id: "scene_first",
        initial_id: 5,
        wang_color: "ff0a0b0c",
        wang_noise_percent: 0,
        wang_curvature: 0.5,
        wang_noise_type: 0,
        graphics: {
          texture_file: "first.png",
          color: "ffffffff",
          randomize_colors: false,
        },
      },
      {
        id: "scene_last",
        initial_id: 6,
        wang_color: "ff0d0e0f",
        wang_noise_percent: 0,
        wang_curvature: 0.5,
        wang_noise_type: 0,
        graphics: {
          texture_file: "last.png",
          color: "ffffffff",
          randomize_colors: false,
        },
      },
    ];
    const registry = new NativeMaterialAppearanceRegistry(
      materials,
      new Map([
        [
          "base.png",
          { width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) },
        ],
        [
          "first.png",
          { width: 1, height: 1, rgba: new Uint8Array([20, 30, 40, 255]) },
        ],
        [
          "last.png",
          { width: 1, height: 1, rgba: new Uint8Array([50, 60, 70, 255]) },
        ],
      ]),
    );
    const configuration: BiomeMaterialsConfiguration = {
      biomeName: "test",
      sourcePath: "test.xml",
      aggregateMaterialMin: 0,
      aggregateMaterialMax: 1,
      records: [],
      unresolvedMaterialNames: [],
    };
    const first = compilePixelSceneStamp(
      {
        key: "test/first",
        name: "first",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        rgba: new Uint8Array([0x0a, 0x0b, 0x0c, 255]),
      },
      registry,
    );
    const last = compilePixelSceneStamp(
      {
        key: "test/last",
        name: "last",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        rgba: new Uint8Array([0x0d, 0x0e, 0x0f, 255]),
      },
      registry,
    );
    const result = createWholeMapTerrainTileSource(
      [makeLayer(1, 1, 0x040506)],
      registry,
      {
        worldSeed: 123,
        biomeMaterials: new Map([["test", configuration]]),
        worldCenter: 0,
        parallelWorld: 0,
        verticalPlane: 0,
        worldWidthChunks: 70,
        pixelSceneStamps: [first, last],
      },
    );
    expect(result).not.toBeNull();
    const tile = await renderTile(result!.tileSource, 4, 0, 0);
    expect(Array.from(tile.pixels!.subarray(0, 4))).toEqual([50, 60, 70, 255]);
  });

  it("owns the biome-map extent, culls transparent tiles, and cancels queued work", async () => {
    const material: CanonicalMaterialDefinition = {
      id: "test_material",
      initial_id: 4,
      wang_color: "ff040506",
      wang_noise_percent: 0,
      wang_curvature: 0.5,
      wang_noise_type: 0,
      graphics: {
        texture_file: "test.png",
        color: "ffffffff",
        randomize_colors: false,
      },
    };
    const registry = new NativeMaterialAppearanceRegistry(
      [material],
      new Map([
        [
          "test.png",
          {
            width: 1,
            height: 1,
            rgba: new Uint8Array([1, 2, 3, 255]),
          },
        ],
      ]),
    );
    const configuration: BiomeMaterialsConfiguration = {
      biomeName: "test",
      sourcePath: "test.xml",
      aggregateMaterialMin: 0,
      aggregateMaterialMax: 1,
      records: [],
      unresolvedMaterialNames: [],
    };
    const layer = makeLayer(52, 1, 0x040506);
    layer.correctedY = 0;
    const result = createWholeMapTerrainTileSource([layer], registry, {
      worldSeed: 123,
      biomeMaterials: new Map([["test", configuration]]),
      worldCenter: 0,
      parallelWorld: 0,
      verticalPlane: 0,
      worldWidthChunks: 2,
      biomeMap: {
        pixels: new Uint32Array([0xff123456, 0xff36d517]),
        width: 2,
        height: 1,
        colorToName: new Map([
          [0x123456, "test"],
          [0x36d517, "hills"],
        ]),
      },
    });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      originX: 0,
      originY: -7168,
      width: 1024,
      height: 512,
    });
    expect(result!.coverage).toMatchObject({
      declaredBiomeMapChunks: 2,
      wangBackedBiomeMapChunks: 1,
      unsupportedBiomeMapChunks: 1,
      unsupportedBiomeMapChunksByName: { hills: 1 },
    });
    expect(result!.tileSource.tileExists(10, 0, 0)).toBe(true);
    expect(result!.tileSource.tileExists(10, 1, 0)).toBe(false);

    const unsupportedChunk = await renderTile(result!.tileSource, 10, 1, 0);
    expect(Array.from(unsupportedChunk.pixels!.subarray(0, 4))).toEqual([
      0, 0, 0, 0,
    ]);

    let cancelledTileFinished = false;
    const cancelledContext = {
      tile: { level: 10, x: 0, y: 0 },
      userData: {},
      finish: () => {
        cancelledTileFinished = true;
      },
      fail: () => {
        cancelledTileFinished = true;
      },
    };
    result!.tileSource.downloadTileStart(cancelledContext);
    result!.tileSource.downloadTileAbort(cancelledContext);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cancelledTileFinished).toBe(false);

    const diagnosticResult = createWholeMapTerrainTileSource(
      [layer],
      registry,
      {
        worldSeed: 123,
        biomeMaterials: new Map([["test", configuration]]),
        worldCenter: 0,
        parallelWorld: 0,
        verticalPlane: 0,
        worldWidthChunks: 2,
        showResolutionDiagnostics: true,
        biomeMap: {
          pixels: new Uint32Array([0xff123456, 0xff36d517]),
          width: 2,
          height: 1,
          colorToName: new Map([
            [0x123456, "test"],
            [0x36d517, "hills"],
          ]),
        },
      },
    );
    expect(diagnosticResult!.tileSource.tileExists(10, 1, 0)).toBe(true);
    const diagnosticChunk = await renderTile(
      diagnosticResult!.tileSource,
      10,
      1,
      0,
    );
    expect(Array.from(diagnosticChunk.pixels!.subarray(0, 4))).toEqual([
      128, 32, 0, 255,
    ]);
  });
});
