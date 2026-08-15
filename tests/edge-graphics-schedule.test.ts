import { describe, expect, it } from "vitest";

import {
  buildExperimentalEdgeGraphicsSchedule,
  deriveStandaloneEdgeGraphicsChunkState,
  EDGE_GRAPHICS_TLS_INITIAL_STATE,
  EdgeGraphicsCheckpointBaker,
  V2_FIRST_WORLD_PUBLICATION_PREFIX,
} from "../src/terrain/edge-graphics-schedule";
import { consumeInteriorEdgeGraphicsChunkRng } from "../src/terrain/edge-graphics-renderer";
import type { EdgeGraphicsCellGrid, EdgeGraphicsInventory } from "../src/terrain/edge-graphics";
import { NativeMaterialAppearanceRegistry } from "../src/terrain/material-appearance";

function fixtureGrid(): EdgeGraphicsCellGrid {
  const cells: EdgeGraphicsCellGrid["cells"] = new Array(512 * 512).fill(null);
  for (let y = 0; y < 512; y += 1) {
    for (let x = 0; x < 256; x += 1) {
      cells[y * 512 + x] = { materialId: 7, visualAabbggrr: 0, markerAabbggrr: 0 };
    }
  }
  return { width: 512, height: 512, cells };
}

function fixtures() {
  const registry = new NativeMaterialAppearanceRegistry([{
    id: "fixture",
    initial_id: 7,
    wang_color: null,
    cell_type: "solid",
    graphics: { texture_file: "", color: "FF102030", randomize_colors: false },
  }], new Map());
  const material = {
    materialName: "fixture",
    parentMaterialName: null,
    definitions: [{
      z: 1,
      type: "EVERYWHERE" as const,
      percent: 1,
      requireSameMaterial: true,
      requireSameMaterialType: false,
      overwrite: false,
      packedColorAabbggrr: 0,
      images: [{
        filename: "edge.png",
        minAngle: 0,
        maxAngle: 1,
        doOnlyHorizontalStripe: false,
        doOnlyVerticalStripe: false,
        allowRandomRotation: false,
      }],
    }],
  };
  const inventory: EdgeGraphicsInventory = {
    materials: [material],
    directRecordCount: 1,
    directImageCount: 1,
    uniqueImagePaths: ["edge.png"],
    effectiveMaterials: [material],
    effectiveRecordCount: 1,
    effectiveImageCount: 1,
  };
  return { registry, inventory };
}

describe("EdgeGraphics schedule checkpoints", () => {
  it("preserves the exact V2 startup prefix before its labeled continuation", () => {
    const schedule = buildExperimentalEdgeGraphicsSchedule(-4, 4, -4, 4);
    expect(schedule.slice(0, V2_FIRST_WORLD_PUBLICATION_PREFIX.length))
      .toEqual(V2_FIRST_WORLD_PUBLICATION_PREFIX);
    expect(new Set(schedule.map(({ x, y }) => `${x},${y}`)).size).toBe(schedule.length);
    expect(schedule).toHaveLength(81);
  });

  it("retains independent TLS streams and advances each worker in schedule order", () => {
    const { registry, inventory } = fixtures();
    const schedule = buildExperimentalEdgeGraphicsSchedule(-2, 2, -2, 2);
    const baker = new EdgeGraphicsCheckpointBaker(
      schedule,
      registry,
      inventory,
      () => fixtureGrid(),
      123,
      25,
      2,
    );
    const first = baker.checkpointFor(schedule[0].x, schedule[0].y)!;
    const second = baker.checkpointFor(schedule[1].x, schedule[1].y)!;
    const third = baker.checkpointFor(schedule[2].x, schedule[2].y)!;
    const consumed = consumeInteriorEdgeGraphicsChunkRng(
      fixtureGrid(),
      schedule[0].x * 512,
      schedule[0].y * 512,
      registry,
      inventory,
      EDGE_GRAPHICS_TLS_INITIAL_STATE,
    );

    expect(first.rngInitialState).toBe(EDGE_GRAPHICS_TLS_INITIAL_STATE);
    expect(first.workerIndex).toBe(0);
    expect(second.rngInitialState).toBe(EDGE_GRAPHICS_TLS_INITIAL_STATE);
    expect(second.workerIndex).toBe(1);
    expect(third.rngInitialState).toBe(consumed.rngFinalState);
    expect(third.workerIndex).toBe(0);
    expect(baker.checkpointFor(schedule[1].x, schedule[1].y)).toEqual(second);
  });

  it("provides seed- and coordinate-stable MINSTD states outside the replay window", () => {
    const { registry, inventory } = fixtures();
    const schedule = buildExperimentalEdgeGraphicsSchedule(-4, 4, -4, 4);
    const baker = new EdgeGraphicsCheckpointBaker(
      schedule,
      registry,
      inventory,
      () => fixtureGrid(),
      0x2ef4216c,
      1,
      8,
    );
    const coordinate = schedule[40];
    const checkpoint = baker.checkpointFor(coordinate.x, coordinate.y)!;

    expect(checkpoint.stateSource).toBe("seed-coordinate-canonical");
    expect(checkpoint.rngInitialState).toBe(
      deriveStandaloneEdgeGraphicsChunkState(0x2ef4216c, coordinate.x, coordinate.y),
    );
    expect(checkpoint.rngInitialState).toBeGreaterThan(0);
    expect(checkpoint.rngInitialState).toBeLessThan(0x7fffffff);
    expect(deriveStandaloneEdgeGraphicsChunkState(0x2ef4216c, coordinate.x, coordinate.y))
      .not.toBe(deriveStandaloneEdgeGraphicsChunkState(0x2ef4216d, coordinate.x, coordinate.y));
    expect(deriveStandaloneEdgeGraphicsChunkState(0x2ef4216c, coordinate.x, coordinate.y))
      .not.toBe(deriveStandaloneEdgeGraphicsChunkState(0x2ef4216c, coordinate.x + 1, coordinate.y));
  });
});
