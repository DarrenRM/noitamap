import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { CanonicalMaterialDefinition } from "../src/terrain/material-appearance";
import {
  biomeManagerVegetationSeed,
  generateGrassOverlayRulesForBiomeSeed,
  parseBiomeVegetationConfiguration,
  type BiomeVegetationConfiguration,
} from "../src/terrain/vegetation";

const DOUBLE = new DataView(new ArrayBuffer(8));

function bitsOf(value: number): bigint {
  DOUBLE.setFloat64(0, value, true);
  return DOUBLE.getBigUint64(0, true);
}

function material(id: string, initialId: number): CanonicalMaterialDefinition {
  return {
    id,
    initial_id: initialId,
    wang_color: null,
    graphics: { texture_file: "", color: "ffffffff", randomize_colors: false },
  };
}

describe("native vegetation candidate and grass-overlay route", () => {
  it("derives the exact BiomeManager+0x30 seed for seed one", () => {
    expect(bitsOf(biomeManagerVegetationSeed(1))).toBe(0x409490fc60000000n);
  });

  it("matches the reconstructed one-component candidate witness", () => {
    const configuration: BiomeVegetationConfiguration = {
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
    const result = generateGrassOverlayRulesForBiomeSeed(configuration, 1, 0, 512);
    expect(result.componentShuffleSeed).toBe(514400);
    expect(result.rawCandidatesEmitted).toBe(1);
    expect(result.rules).toEqual([{
      componentIndex: 0,
      grassRequiresNeighbors: false,
      treeMaterialId: 158,
      materialOnTopOfId: 116,
    }]);
  });

  it("parses defaults, resolves grass materials, and preserves postparse range order", () => {
    const xml = `<Biome><Materials>
      <VegetationComponent tree_image_file="tree_$[3-5].png" tree_material="wood" />
      <VegetationComponent is_visual="1" is_grass="1" tree_material="grass" material_on_top_of="soil" grass_requires_neighbors="1" />
    </Materials></Biome>`;
    const parsed = parseBiomeVegetationConfiguration(
      xml,
      "test",
      "test.xml",
      [material("wood", 12), material("grass", 158), material("soil", 116)],
    );
    expect(parsed.components.map((entry) => entry.treeImageFile)).toEqual([
      "tree_3.png",
      "tree_4.png",
      "tree_5.png",
      "",
    ]);
    expect(parsed.components.map((entry) => entry.randSeed)).toEqual([
      Math.fround(1234 + 3 * 501),
      Math.fround(1234 + 4 * 501),
      Math.fround(1234),
      Math.fround(1234),
    ]);
    expect(parsed.components[3]).toMatchObject({
      isGrass: true,
      treeMaterialId: 158,
      materialOnTopOfId: 116,
      grassRequiresNeighbors: true,
    });
    expect(parsed.unresolvedMaterialNames).toEqual([]);
  });

  it("parses every vegetation vector declared by the standalone asset package", async () => {
    const zip = await JSZip.loadAsync(await readFile("public/terrain-assets.zip"));
    const indexFile = zip.file("terrain/biome-config-index.json");
    const materialsFile = zip.file("terrain/materials.json");
    expect(indexFile).not.toBeNull();
    expect(materialsFile).not.toBeNull();
    const index = JSON.parse(await indexFile!.async("string")) as Record<string, string>;
    const materials = JSON.parse(
      await materialsFile!.async("string"),
    ) as CanonicalMaterialDefinition[];

    let componentCount = 0;
    let grassCount = 0;
    const unresolved = new Set<string>();
    for (const [biomeName, sourcePath] of Object.entries(index)) {
      const file = zip.file(sourcePath);
      expect(file, sourcePath).not.toBeNull();
      const parsed = parseBiomeVegetationConfiguration(
        await file!.async("string"),
        biomeName,
        sourcePath,
        materials,
      );
      componentCount += parsed.components.length;
      grassCount += parsed.components.filter((component) => component.isGrass).length;
      for (const name of parsed.unresolvedMaterialNames) unresolved.add(name);
    }

    expect(Object.keys(index)).toHaveLength(39);
    expect(componentCount).toBeGreaterThan(0);
    expect(grassCount).toBeGreaterThan(0);
    expect(Array.from(unresolved)).toEqual([]);
  });
});
