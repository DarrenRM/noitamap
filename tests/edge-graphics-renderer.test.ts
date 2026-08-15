import { describe, expect, it } from "vitest";

import {
  applyInteriorEdgeGraphicsChunk,
  applyPixelSceneEdgeGraphics,
  computeEdgeGraphicsNormalAngle,
  consumeInteriorEdgeGraphicsChunkRng,
  publishedInteriorMaterialTypeMatches,
  PIXEL_SCENE_AIR_MATERIAL,
  PIXEL_SCENE_PRESERVE_MATERIAL,
} from "../src/terrain/edge-graphics-renderer";
import type {
  EdgeGraphicsCellGrid,
  EdgeGraphicsDefinition,
  EdgeGraphicsInventory,
} from "../src/terrain/edge-graphics";
import { NativeMaterialAppearanceRegistry } from "../src/terrain/material-appearance";

const SIZE = 512;

function fixtureGrid(): EdgeGraphicsCellGrid {
  const cells: EdgeGraphicsCellGrid["cells"] = new Array(SIZE * SIZE).fill(null);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < 256; x += 1) {
      cells[y * SIZE + x] = {
        materialId: 7,
        visualAabbggrr: 0xff302010,
        markerAabbggrr: 0xff302010,
      };
    }
  }
  return { width: SIZE, height: SIZE, cells };
}

describe("whole-chunk interior EdgeGraphics renderer", () => {
  it("stops surface-normal probes at the native radius", () => {
    const registry = new NativeMaterialAppearanceRegistry([{
      id: "rock",
      initial_id: 1,
      wang_color: null,
      cell_type: "solid",
      graphics: { texture_file: "", color: "FF112233", randomize_colors: false },
    }], new Map());
    const cells = Array.from({ length: 64 * 64 }, () => ({
      materialId: 1,
      visualAabbggrr: 0xff112233,
      markerAabbggrr: 0xff112233,
    }));
    const grid = { width: 64, height: 64, cells };

    // The nearest empty cell is eleven pixels left. Radius 5 cannot see it;
    // the former port incorrectly walked the squared-distance bound (25 px).
    expect(computeEdgeGraphicsNormalAngle(grid, registry, 10, 32, false)).toBeUndefined();
    expect(computeEdgeGraphicsNormalAngle(grid, registry, 4, 32, false)).toBeDefined();
  });

  it("projects GenerateTerrain scene-age bytes when comparing soil and static rock", () => {
    const registry = new NativeMaterialAppearanceRegistry([{
      id: "rock_static",
      initial_id: 8,
      wang_color: null,
      cell_type: "liquid",
      platform_type: 1,
      liquid_static: true,
      liquid_sand: true,
      liquid_sand_never_box2d: false,
      liquid_sticks_to_ceiling: 0,
      graphics: { texture_file: "", color: "FF313B36", randomize_colors: false },
    }, {
      id: "soil",
      initial_id: 116,
      wang_color: null,
      cell_type: "liquid",
      platform_type: -1,
      liquid_static: false,
      liquid_sand: true,
      liquid_sand_never_box2d: false,
      liquid_sticks_to_ceiling: 50,
      graphics: { texture_file: "", color: "FF36311E", randomize_colors: false },
    }], new Map());
    const rock = { materialId: 8, visualAabbggrr: 0, markerAabbggrr: 0 };
    const soil = { materialId: 116, visualAabbggrr: 0, markerAabbggrr: 0 };

    expect(publishedInteriorMaterialTypeMatches(rock, rock, registry)).toBe(true);
    expect(publishedInteriorMaterialTypeMatches(rock, soil, registry)).toBe(false);
  });

  it("keeps fresh static rock and coal in the same native material-type mask", () => {
    const registry = new NativeMaterialAppearanceRegistry([{
      id: "rock_static",
      initial_id: 8,
      wang_color: null,
      cell_type: "liquid",
      platform_type: 1,
      liquid_static: true,
      liquid_sand: true,
      liquid_sand_never_box2d: false,
      liquid_sticks_to_ceiling: 0,
      graphics: { texture_file: "", color: "FF313B36", randomize_colors: false },
    }, {
      id: "coal_static",
      initial_id: 432,
      wang_color: null,
      cell_type: "liquid",
      platform_type: 1,
      liquid_static: true,
      liquid_sand: true,
      liquid_sand_never_box2d: false,
      liquid_sticks_to_ceiling: 50,
      graphics: { texture_file: "", color: "FF181818", randomize_colors: false },
    }], new Map());
    const rock = { materialId: 8, visualAabbggrr: 0, markerAabbggrr: 0 };
    const coal = { materialId: 432, visualAabbggrr: 0, markerAabbggrr: 0 };

    expect(publishedInteriorMaterialTypeMatches(rock, coal, registry)).toBe(true);
    expect(publishedInteriorMaterialTypeMatches(coal, rock, registry)).toBe(true);
  });

  it("is deterministic, decorates admitted interior boundaries, and leaves the 8-cell border alone", () => {
    const registry = new NativeMaterialAppearanceRegistry([{
      id: "fixture_soil",
      initial_id: 7,
      wang_color: null,
      cell_type: "solid",
      graphics: { texture_file: "", color: "FF102030", randomize_colors: false },
    }], new Map());
    const definition: EdgeGraphicsDefinition = {
      z: 1,
      type: "EVERYWHERE",
      percent: 1,
      requireSameMaterial: true,
      requireSameMaterialType: false,
      overwrite: false,
      packedColorAabbggrr: 0xff123123,
      images: [{
        filename: "data/edge.png",
        minAngle: 0,
        maxAngle: 1,
        doOnlyHorizontalStripe: false,
        doOnlyVerticalStripe: false,
        allowRandomRotation: false,
      }],
    };
    const material = { materialName: "fixture_soil", parentMaterialName: null, definitions: [definition] };
    const inventory: EdgeGraphicsInventory = {
      materials: [material],
      directRecordCount: 1,
      directImageCount: 1,
      uniqueImagePaths: ["data/edge.png"],
      effectiveMaterials: [material],
      effectiveRecordCount: 1,
      effectiveImageCount: 1,
    };
    const images = new Map([["data/edge.png", {
      width: 1,
      height: 1,
      rgba: new Uint8Array([0xef, 0xcd, 0xab, 0xff]),
    }]]);
    const first = fixtureGrid();
    const second = fixtureGrid();

    const firstResult = applyInteriorEdgeGraphicsChunk(first, 0, 0, registry, inventory, images);
    const secondResult = applyInteriorEdgeGraphicsChunk(second, 0, 0, registry, inventory, images);

    expect(firstResult).toEqual(secondResult);
    expect(first.cells).toEqual(second.cells);
    expect(firstResult.cellsVisited).toBe(496 * 496);
    expect(firstResult.stampCalls).toBeGreaterThan(0);
    expect(firstResult.writtenPixels).toBeGreaterThan(0);
    expect(firstResult.missingImages).toEqual([]);
    expect(first.cells[100 * SIZE + 255]?.visualAabbggrr).not.toBe(0xff302010);
    expect(first.cells[4 * SIZE + 255]?.visualAabbggrr).toBe(0xff302010);
  });

  it("can checkpoint the continuous TLS stream without painting preceding chunks", () => {
    const registry = new NativeMaterialAppearanceRegistry([{
      id: "fixture_soil",
      initial_id: 7,
      wang_color: null,
      cell_type: "solid",
      graphics: { texture_file: "", color: "FF102030", randomize_colors: false },
    }], new Map());
    const definition: EdgeGraphicsDefinition = {
      z: 1,
      type: "EVERYWHERE",
      percent: 1,
      requireSameMaterial: true,
      requireSameMaterialType: false,
      overwrite: false,
      packedColorAabbggrr: 0xff123123,
      images: [{
        filename: "data/edge.png",
        minAngle: 0,
        maxAngle: 1,
        doOnlyHorizontalStripe: false,
        doOnlyVerticalStripe: false,
        allowRandomRotation: true,
      }],
    };
    const material = { materialName: "fixture_soil", parentMaterialName: null, definitions: [definition] };
    const inventory: EdgeGraphicsInventory = {
      materials: [material],
      directRecordCount: 1,
      directImageCount: 1,
      uniqueImagePaths: ["data/edge.png"],
      effectiveMaterials: [material],
      effectiveRecordCount: 1,
      effectiveImageCount: 1,
    };
    const images = new Map([["data/edge.png", {
      width: 1,
      height: 1,
      rgba: new Uint8Array([0xef, 0xcd, 0xab, 0xff]),
    }]]);

    const rendered = applyInteriorEdgeGraphicsChunk(
      fixtureGrid(), 0, 0, registry, inventory, images,
    );
    const consumed = consumeInteriorEdgeGraphicsChunkRng(
      fixtureGrid(), 0, 0, registry, inventory,
    );

    expect(consumed.rngInitialState).toBe(rendered.rngInitialState);
    expect(consumed.rngFinalState).toBe(rendered.rngFinalState);
    expect(consumed.rngDraws).toBe(rendered.rngDraws);
    expect(consumed.writtenPixels).toBe(0);
  });

  it("applies the distinct PixelScene-local edge pass after scene material publication", () => {
    const registry = new NativeMaterialAppearanceRegistry([{
      id: "scene_rock",
      initial_id: 41,
      wang_color: null,
      cell_type: "solid",
      graphics: { texture_file: "", color: "FF202020", randomize_colors: false },
    }], new Map());
    const definition: EdgeGraphicsDefinition = {
      z: 1,
      type: "EVERYWHERE",
      percent: 1,
      requireSameMaterial: true,
      requireSameMaterialType: false,
      overwrite: false,
      packedColorAabbggrr: 0xffffffff,
      images: [{
        filename: "data/scene-edge.png",
        minAngle: 0,
        maxAngle: Math.fround(Math.PI * 2),
        doOnlyHorizontalStripe: false,
        doOnlyVerticalStripe: false,
        allowRandomRotation: false,
      }],
    };
    const material = { materialName: "scene_rock", parentMaterialName: null, definitions: [definition] };
    const inventory: EdgeGraphicsInventory = {
      materials: [material],
      directRecordCount: 1,
      directImageCount: 1,
      uniqueImagePaths: ["data/scene-edge.png"],
      effectiveMaterials: [material],
      effectiveRecordCount: 1,
      effectiveImageCount: 1,
    };
    const images = new Map([["data/scene-edge.png", {
      width: 1,
      height: 1,
      rgba: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    }]]);
    const grid: EdgeGraphicsCellGrid = {
      width: SIZE,
      height: SIZE,
      cells: new Array(SIZE * SIZE).fill(null),
    };
    const width = 8;
    const height = 8;
    const materialIds = new Int32Array(width * height);
    materialIds.fill(PIXEL_SCENE_AIR_MATERIAL);
    const stampedMaterialIds = new Int32Array(width * height);
    stampedMaterialIds.fill(PIXEL_SCENE_PRESERVE_MATERIAL);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        materialIds[y * width + x] = 41;
        stampedMaterialIds[y * width + x] = 41;
        grid.cells[(20 + y) * SIZE + 20 + x] = {
          materialId: 41,
          visualAabbggrr: 0xff202020,
          markerAabbggrr: 0xff202020,
          concreteType: "solid",
        };
      }
    }
    const result = applyPixelSceneEdgeGraphics(
      grid,
      0,
      0,
      20,
      20,
      0,
      12345,
      { width, height, materialIds, stampedMaterialIds },
      (worldX, worldY) => (
        worldX >= 20 && worldX < 24 && worldY >= 20 && worldY < 28 ? 41 : null
      ),
      registry,
      inventory,
      images,
    );

    expect(result.cellsVisited).toBe(36);
    expect(result.stampCalls).toBeGreaterThan(0);
    expect(result.writtenPixels).toBeGreaterThan(0);
    expect(grid.cells[23 * SIZE + 23]?.visualAabbggrr).not.toBe(0xff202020);
  });
});
