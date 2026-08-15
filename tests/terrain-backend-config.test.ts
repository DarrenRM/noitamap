import { describe, expect, it } from "vitest";

import {
  isReconstructedTerrainEnabled,
  isTerrainResolutionDiagnosticsEnabled,
  RECONSTRUCTED_TERRAIN_CACHE_TAG,
  terrainVisualCacheKey,
} from "../src/terrain/backend-config";

describe("reconstructed terrain backend configuration", () => {
  it("requires the explicit reconstructed backend value", () => {
    expect(isReconstructedTerrainEnabled("?terrainBackend=reconstructed")).toBe(
      true,
    );
    expect(isReconstructedTerrainEnabled("?terrainBackend=legacy")).toBe(false);
    expect(isReconstructedTerrainEnabled("?nb=1")).toBe(false);
  });

  it("keeps resolution diagnostics independently opt-in", () => {
    const search = "?terrainBackend=reconstructed&terrainDiagnostics=1";
    expect(isTerrainResolutionDiagnosticsEnabled(search)).toBe(true);
    expect(isTerrainResolutionDiagnosticsEnabled("?terrainDiagnostics=0")).toBe(
      false,
    );
  });

  it("namespaces cached generation with the manifested asset package", () => {
    expect(RECONSTRUCTED_TERRAIN_CACHE_TAG).toMatch(
      /^terrain-reconstructed-v4-[0-9a-f]{16}$/,
    );
    expect(
      terrainVisualCacheKey(
        "scene-without-variant",
        "?terrainBackend=reconstructed",
      ),
    ).toBe("scene-without-variant|reconstructed-visual-v1");
    expect(
      terrainVisualCacheKey("scene-without-variant", "?terrainBackend=legacy"),
    ).toBe("scene-without-variant");
  });
});
