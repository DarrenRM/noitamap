import { readFileSync } from "node:fs";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { decodePngToRgba } from "../src/telescope/png-decode";

describe("PNG decoding", () => {
  it("honors the black tRNS color key in packaged EdgeGraphics stamps", async () => {
    const zip = await JSZip.loadAsync(readFileSync("public/terrain-assets.zip"));
    const file = zip.file("data/materials_gfx/edge_files/edge_rock_1.png");
    expect(file).not.toBeNull();
    const encoded = await file!.async("arraybuffer");
    const decoded = decodePngToRgba(encoded);

    let transparentPixels = 0;
    for (let offset = 0; offset < decoded.data.length; offset += 4) {
      if (decoded.data[offset + 3] !== 0) continue;
      transparentPixels += 1;
      expect(Array.from(decoded.data.subarray(offset, offset + 4))).toEqual([0, 0, 0, 0]);
    }
    expect(transparentPixels).toBe(167);
  });
});
