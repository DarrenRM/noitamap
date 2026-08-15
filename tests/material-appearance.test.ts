import { describe, expect, it } from "vitest";

import {
  type CanonicalMaterialDefinition,
  NativeMaterialAppearanceRegistry,
  randomizeMaterialTextureCoordinates,
} from "../src/terrain/material-appearance";

const materials: CanonicalMaterialDefinition[] = [
  {
    id: "textured",
    initial_id: 42,
    wang_color: "FF102030",
    graphics: {
      texture_file: "data/materials_gfx/textured.png",
      color: null,
      randomize_colors: false,
    },
  },
  {
    id: "solid",
    initial_id: 43,
    wang_color: "FF405060",
    graphics: {
      texture_file: "",
      color: "FF112233",
      randomize_colors: false,
    },
  },
];

describe("native material appearance", () => {
  it("samples authored textures in native world coordinates with signed wrapping", () => {
    const registry = new NativeMaterialAppearanceRegistry(
      materials,
      new Map([
        [
          "data/materials_gfx/textured.png",
          {
            width: 2,
            height: 2,
            rgba: new Uint8Array([
              1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255,
            ]),
          },
        ],
      ]),
    );

    expect(registry.sample(42, 0, 0)).toMatchObject({
      status: "sampled",
      packedAabbggrr: 0xff030201,
    });
    expect(registry.sample(42, -1, -1)).toMatchObject({
      status: "sampled",
      packedAabbggrr: 0xff0c0b0a,
    });
    expect(registry.sample(43, 100, -100)).toMatchObject({
      status: "sampled",
      packedAabbggrr: 0xff332211,
    });
  });

  it("fails closed for air, unknown identities, and absent authored textures", () => {
    const registry = new NativeMaterialAppearanceRegistry(materials, new Map());
    expect(registry.sample(0, 0, 0, 0)).toEqual({ status: "air" });
    expect(registry.sample(999, 0, 0)).toEqual({
      status: "unknown-material",
      materialId: 999,
    });
    expect(registry.sample(42, 0, 0)).toMatchObject({
      status: "missing-texture",
      texturePath: "data/materials_gfx/textured.png",
    });
  });

  it("keeps coordinate-randomized texture sampling stateless and order-independent", () => {
    const coordinates: Array<[number, number]> = [
      [-512, -512],
      [-1, 0],
      [0, 0],
      [12345, -6789],
      [0x7fffffff, -0x80000000],
    ];
    const forward = coordinates.map(([x, y]) =>
      randomizeMaterialTextureCoordinates(x, y),
    );
    const reverse = [...coordinates]
      .reverse()
      .map(([x, y]) => randomizeMaterialTextureCoordinates(x, y))
      .reverse();
    expect(reverse).toEqual(forward);
  });
});
