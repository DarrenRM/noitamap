import { TERRAIN_ASSET_PACKAGE_SHA256 } from "./generated-asset-package";

export const RECONSTRUCTED_TERRAIN_CACHE_TAG = `terrain-reconstructed-v4-${TERRAIN_ASSET_PACKAGE_SHA256.slice(0, 16).toLowerCase()}`;

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

export function isReconstructedTerrainEnabled(
  search = currentSearch(),
): boolean {
  return new URLSearchParams(search).get("terrainBackend") === "reconstructed";
}

export function isTerrainResolutionDiagnosticsEnabled(
  search = currentSearch(),
): boolean {
  return new URLSearchParams(search).get("terrainDiagnostics") === "1";
}

export function terrainVisualCacheKey(
  baseKey: string,
  search = currentSearch(),
): string {
  return isReconstructedTerrainEnabled(search)
    ? `${baseKey}|reconstructed-visual-v1`
    : baseKey;
}
