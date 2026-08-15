import type { TileLayer } from "../telescope/telescope-adapter";
import type { LoadedNativeMaterialAssets } from "./material-assets";
import type { CompiledPixelSceneStamp } from "./pixel-scene-stamp";
import { createWholeMapTerrainTileSource } from "./whole-map-tile-source";

interface TerrainDiagnosticsWindow extends Window {
  __reconstructedTerrainCoverage?: Record<string, unknown>;
}

export interface ReconstructedTerrainPlaneOptions {
  viewer: any;
  assets: LoadedNativeMaterialAssets;
  tileLayers: readonly TileLayer[];
  worldSeed: number;
  worldCenter: number;
  parallelWorld: number;
  verticalPlane: number;
  worldWidthChunks: number;
  cacheNamespace: string;
  showResolutionDiagnostics: boolean;
  pixelSceneStamps: readonly CompiledPixelSceneStamp[];
  biomeMapPixels?: Uint32Array;
  biomeMapColorToName: ReadonlyMap<number, string>;
  isCurrentGeneration: () => boolean;
  registerDynamicItem: (item: any) => void;
}

function registerTileLayer(
  viewer: any,
  placement: {
    tileSource: any;
    originX: number;
    originY: number;
    width: number;
  },
  isCurrentGeneration: () => boolean,
  registerDynamicItem: (item: any) => void,
): void {
  viewer.addTiledImage({
    tileSource: placement.tileSource,
    x: placement.originX,
    y: placement.originY,
    width: placement.width,
    success: (event: any) => {
      if (!isCurrentGeneration()) {
        try {
          viewer.world.removeItem(event.item);
        } catch {}
        return;
      }
      registerDynamicItem(event.item);
    },
  });
}

function publishCoverage(
  parallelWorld: number,
  verticalPlane: number,
  coverage: unknown,
): void {
  const coverageKey = `${parallelWorld},${verticalPlane}`;
  const diagnosticsWindow = window as TerrainDiagnosticsWindow;
  const reports = (diagnosticsWindow.__reconstructedTerrainCoverage ??= {});
  reports[coverageKey] = coverage;
  document.documentElement.dataset.reconstructedTerrainCoverage =
    JSON.stringify(reports);
  console.warn(`[ReconstructedTerrain] coverage ${coverageKey}`, coverage);
}

/** Adds one reconstructed PW/vertical-plane layer to the existing OSD world. */
export function addReconstructedTerrainPlane(
  options: ReconstructedTerrainPlaneOptions,
): boolean {
  const biomeMap = options.biomeMapPixels
    ? {
        pixels: options.biomeMapPixels,
        width: options.worldWidthChunks,
        height: Math.floor(
          options.biomeMapPixels.length / options.worldWidthChunks,
        ),
        colorToName: options.biomeMapColorToName,
      }
    : undefined;
  const reconstructed = createWholeMapTerrainTileSource(
    options.tileLayers,
    options.assets.registry,
    {
      worldSeed: options.worldSeed,
      biomeMaterials: options.assets.biomeMaterials,
      biomeVegetation: options.assets.biomeVegetation,
      worldCenter: options.worldCenter,
      parallelWorld: options.parallelWorld,
      verticalPlane: options.verticalPlane,
      worldWidthChunks: options.worldWidthChunks,
      cacheNamespace: options.cacheNamespace,
      showResolutionDiagnostics: options.showResolutionDiagnostics,
      pixelSceneStamps: options.pixelSceneStamps,
      edgeGraphics: options.assets.edgeGraphics,
      edgeGraphicsImages: options.assets.edgeGraphicsImages,
      biomeMap,
    },
  );
  if (!reconstructed) return false;

  publishCoverage(
    options.parallelWorld,
    options.verticalPlane,
    reconstructed.coverage,
  );
  registerTileLayer(
    options.viewer,
    reconstructed,
    options.isCurrentGeneration,
    options.registerDynamicItem,
  );
  return true;
}
