import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  adjustEdgeGraphicsMarkerColor,
  blendEdgeGraphicsColors,
  drawBoundedEdgeGraphicsStamp,
  EdgeGraphicsMinstd,
  parseDirectEdgeGraphicsInventory,
  selectBoundedEdgeGraphicsStamp,
  writeBoundedEdgeGraphicsCellPixel,
  type EdgeGraphicsDefinition,
} from "../src/terrain/edge-graphics";

describe("authored EdgeGraphics inventory", () => {
  it("uses the locked native defaults and color/angle representation", () => {
    const inventory = parseDirectEdgeGraphicsInventory(`
      <Materials><CellData name="fixture"><Graphics><Edge>
        <EdgeGraphics><Images><Image filename="edge.png" min_angle="-90" /></Images></EdgeGraphics>
      </Edge></Graphics></CellData></Materials>
    `);
    expect(inventory.directRecordCount).toBe(1);
    expect(inventory.directImageCount).toBe(1);
    expect(inventory.materials[0].definitions[0]).toMatchObject({
      z: Math.fround(1),
      type: "COLOR_EDGE_PIXELS",
      percent: Math.fround(1),
      requireSameMaterial: true,
      requireSameMaterialType: false,
      overwrite: false,
      packedColorAabbggrr: 0xff123123,
    });
    expect(inventory.materials[0].definitions[0].images[0].minAngle).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("matches the canonical direct record and packaged image closure", async () => {
    const zip = await JSZip.loadAsync(await readFile("public/terrain-assets.zip"));
    const xml = await zip.file("data/materials.xml")!.async("string");
    const manifest = JSON.parse(await zip.file("terrain/manifest.json")!.async("string"));
    const inventory = parseDirectEdgeGraphicsInventory(xml);
    const packagedPaths = manifest.entries
      .filter((entry: { purpose: string }) => entry.purpose === "authored-edge-graphics-image")
      .map((entry: { path: string }) => entry.path)
      .sort();

    expect(inventory.directRecordCount).toBe(63);
    expect(inventory.directImageCount).toBe(267);
    expect(inventory.uniqueImagePaths).toHaveLength(118);
    expect(inventory.uniqueImagePaths).toEqual(packagedPaths);
    expect(inventory.effectiveRecordCount).toBe(66);
    expect(inventory.effectiveImageCount).toBe(282);
  });
});

describe("bounded native EdgeGraphics core", () => {
  const image = (minAngle = 0, maxAngle = 1) => ({
    filename: "edge.png",
    minAngle,
    maxAngle,
    doOnlyHorizontalStripe: false,
    doOnlyVerticalStripe: false,
    allowRandomRotation: false,
  });
  const graphics = (): EdgeGraphicsDefinition => ({
    z: 1,
    type: "EVERYWHERE",
    percent: 1,
    requireSameMaterial: true,
    requireSameMaterialType: false,
    overwrite: false,
    packedColorAabbggrr: 0xff123123,
    images: [image()],
  });
  const request = () => ({
    exactMask: [1, 1, 1, 1, 1, 0, 0, 0, 0],
    exactCount: 5,
    compatibleMask: [1, 1, 1, 1, 1, 0, 0, 0, 0],
    compatibleCount: 5,
    localX: 10,
    localY: 20,
  });

  it("matches exact packed-color and marker vectors", () => {
    expect(blendEdgeGraphicsColors(0x40abcdef, 0x80204060)).toBe(0x9f426383);
    expect(blendEdgeGraphicsColors(0x80ff0000, 0xff0000ff)).toBe(0xfe80007e);
    expect(adjustEdgeGraphicsMarkerColor(0x9f426383)).toBe(0x9f426382);
    expect(adjustEdgeGraphicsMarkerColor(0xaabbcc00)).toBe(0xaabbcc01);
  });

  it("matches lazy MINSTD state and inclusive image selection", () => {
    const random = new EdgeGraphicsMinstd();
    const config = graphics();
    config.requireSameMaterial = false;
    config.requireSameMaterialType = true;
    config.images = [image(), image(), image()];
    const result = selectBoundedEdgeGraphicsStamp(config, request(), random);
    expect(result).toMatchObject({
      status: "completed",
      percentGatePassed: true,
      cardinalGatePassed: true,
      imageSelected: true,
      selectedImageIndex: 2,
      rngDraws: 2,
    });
    expect(random.state).toBe(2065330401);
  });

  it("matches cardinal angle selection and stripe adjustment", () => {
    const random = new EdgeGraphicsMinstd();
    const config = graphics();
    config.type = "CARDINAL_DIRECTIONS";
    config.images = [image(3, 4), image(), image(), image(), image()];
    config.images[0].doOnlyHorizontalStripe = true;
    const edgeRequest = request();
    edgeRequest.exactMask = [1, 0, 0, 1, 1, 1, 1, 0, 0];
    const result = selectBoundedEdgeGraphicsStamp(config, edgeRequest, random);
    expect(result).toMatchObject({
      status: "completed",
      normalizedAngleF32Bits: 0x40490fdb,
      selectedImageIndex: 0,
      localX: 11,
      localY: 20,
    });
  });

  it("uses the reconstructed normal angle for authored angle-bucket selection", () => {
    const random = new EdgeGraphicsMinstd();
    const config = graphics();
    config.type = "NORMAL_BASED";
    config.images = [image(0, 1), image(1, 2), image(2, 3)];
    const result = selectBoundedEdgeGraphicsStamp(config, {
      ...request(),
      normalBasedAngle: Math.fround(1.5),
    }, random);
    expect(result).toMatchObject({
      status: "completed",
      cardinalGatePassed: true,
      imageSelected: true,
      selectedImageIndex: 1,
    });
  });

  it("writes the exact visual blend and one-red-step marker gate", () => {
    const cells = new Array(512 * 512).fill(null);
    const anchor = { materialId: 17, visualAabbggrr: 0xff0000ff, markerAabbggrr: 0xff0000ff };
    const target = { ...anchor };
    cells[7 * 512 + 7] = anchor;
    cells[7 * 512 + 8] = target;
    const grid = { width: 512, height: 512, cells };
    const stamp = { width: 1, height: 1, rgba: new Uint8Array([0, 0, 255, 128]) };
    const first = writeBoundedEdgeGraphicsCellPixel(grid, graphics(), stamp, {
      anchorX: 7, anchorY: 7, sampleX: 0, sampleY: 0, targetX: 8, targetY: 7, flipFlags: 0,
    });
    expect(first).toMatchObject({
      outcome: "written",
      blendedAabbggrr: 0xfe80007e,
      markerAabbggrr: 0xfe80007d,
    });
    expect(target).toEqual({ materialId: 17, visualAabbggrr: 0xfe80007e, markerAabbggrr: 0xfe80007d });
    const second = writeBoundedEdgeGraphicsCellPixel(grid, graphics(), stamp, {
      anchorX: 7, anchorY: 7, sampleX: 0, sampleY: 0, targetX: 8, targetY: 7, flipFlags: 0,
    });
    expect(second.outcome).toBe("already-decorated");
  });

  it("models the shared CGasCell current/marker color field", () => {
    const cells = new Array(512 * 512).fill(null);
    const anchor = {
      materialId: 17,
      visualAabbggrr: 0xff0000ff,
      markerAabbggrr: 0xff0000ff,
      concreteType: "gas" as const,
    };
    const target = { ...anchor };
    cells[7 * 512 + 7] = anchor;
    cells[7 * 512 + 8] = target;
    const grid = { width: 512, height: 512, cells };
    const stamp = { width: 1, height: 1, rgba: new Uint8Array([0, 0, 255, 128]) };
    const request = {
      anchorX: 7, anchorY: 7, sampleX: 0, sampleY: 0, targetX: 8, targetY: 7, flipFlags: 0,
    };

    expect(writeBoundedEdgeGraphicsCellPixel(grid, graphics(), stamp, request).outcome).toBe("written");
    expect(target.markerAabbggrr).toBe(target.visualAabbggrr);
    expect(writeBoundedEdgeGraphicsCellPixel(grid, graphics(), stamp, request).outcome).toBe("written");
    expect(target.markerAabbggrr).toBe(target.visualAabbggrr);
  });

  it("reports the native CFireCell no-op setter as a successful write", () => {
    const cells = new Array(512 * 512).fill(null);
    const anchor = {
      materialId: 17,
      visualAabbggrr: 0xff0000ff,
      markerAabbggrr: 0xff0000ff,
      concreteType: "fire" as const,
    };
    const target = { ...anchor };
    cells[7 * 512 + 7] = anchor;
    cells[7 * 512 + 8] = target;
    const grid = { width: 512, height: 512, cells };
    const stamp = { width: 1, height: 1, rgba: new Uint8Array([0, 0, 255, 128]) };

    const result = writeBoundedEdgeGraphicsCellPixel(grid, graphics(), stamp, {
      anchorX: 7, anchorY: 7, sampleX: 0, sampleY: 0, targetX: 8, targetY: 7, flipFlags: 0,
    });
    expect(result.outcome).toBe("written");
    expect(target).toEqual(anchor);
  });

  it("composes a decoded stamp traversal into retained cell colors", () => {
    const cells = new Array(512 * 512).fill(null);
    const cell = { materialId: 17, visualAabbggrr: 0xff102030, markerAabbggrr: 0xff102030 };
    cells[12 * 512 + 13] = cell;
    const grid = { width: 512, height: 512, cells };
    const definition = image();
    const stamp = { width: 1, height: 1, rgba: new Uint8Array([0xef, 0xcd, 0xab, 0xff]) };
    const result = drawBoundedEdgeGraphicsStamp(grid, graphics(), definition, stamp, {
      localX: 13,
      localY: 12,
      chunkOriginX: 0,
      chunkOriginY: 0,
      anchorX: 13,
      anchorY: 12,
    }, new EdgeGraphicsMinstd());
    expect(result).toMatchObject({ status: "completed", cellPixelCalls: 1, rngDraws: 0 });
    expect(cell).toEqual({ materialId: 17, visualAabbggrr: 0xffabcdef, markerAabbggrr: 0xffabcdee });
  });
});
