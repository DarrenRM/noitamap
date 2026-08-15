import type { CanonicalMaterialDefinition, NativeMaterialAppearanceRegistry } from "./material-appearance";
import {
  applyEdgeGraphicsSourceColorToCell,
  colorEdgeGraphicsCell,
  drawBoundedEdgeGraphicsStamp,
  EdgeGraphicsMinstd,
  selectBoundedEdgeGraphicsStamp,
  type EdgeGraphicsCell,
  type EdgeGraphicsCellGrid,
  type EdgeGraphicsDefinition,
  type EdgeGraphicsInventory,
  type EdgeGraphicsStampImage,
} from "./edge-graphics";

const CHUNK_SIZE = 512;
const INTERIOR_MARGIN = 8;
const NORMAL_RADIUS = Math.fround(5);
const NORMAL_ANGLE_STEP = Math.fround(Math.PI / 8);

export interface EdgeGraphicsChunkResult {
  cellsVisited: number;
  cellsWithGraphics: number;
  exactGateRejections: number;
  stampCalls: number;
  writtenPixels: number;
  missingImages: string[];
  rngInitialState: number;
  rngFinalState: number;
  rngDraws: number;
}

type InteriorEdgeGraphicsMode = "render" | "consume-rng";

function cellAt(grid: EdgeGraphicsCellGrid, x: number, y: number): EdgeGraphicsCell | null {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
  return grid.cells[y * grid.width + x] ?? null;
}

function publishedStoredGate(material: CanonicalMaterialDefinition): boolean {
  // CLiquidCell_Create sets Cell+0x22 for freshly published terrain from the
  // authored liquid_static flag. liquid_sticks_to_ceiling is consumed later
  // by the +0x6c classifier; it does not initialize this stored-cell gate.
  return material.cell_type === "liquid" && material.liquid_static === true;
}

function publishedLiquidVslot04(material: CanonicalMaterialDefinition): number {
  if (!material.liquid_sand) return 3;
  // CLiquidCell_Create initializes direction byte +0x20 to 3. Every fresh
  // liquid-sand branch therefore reaches the platform-type projection,
  // independently of the stored-cell gate.
  return (material.platform_type ?? 0) === 0 ? 0 : 1;
}

function publishedLiquidVslot64(material: CanonicalMaterialDefinition): number {
  return material.liquid_sand ? 1 : 0;
}

function publishedLiquidVslot6c(material: CanonicalMaterialDefinition): number {
  // Fresh direction is 3 and the adjacent counter byte is zero. At that
  // state only liquid_static's stored-cell gate selects a nonzero result.
  return publishedStoredGate(material) ? 1 : 0;
}

/** Exact generated-cell compatibility used by the interior 3x3 scanner. */
export function publishedInteriorMaterialTypeMatches(
  left: EdgeGraphicsCell | null,
  right: EdgeGraphicsCell | null,
  registry: NativeMaterialAppearanceRegistry,
): boolean {
  if (!left || !right) return false;
  if (left.materialId === right.materialId) return true;
  const a = registry.materialAtInitialId(left.materialId);
  const b = registry.materialAtInitialId(right.materialId);
  if (!a || !b) return false;
  return publishedLiquidVslot04(a) === publishedLiquidVslot04(b) &&
    publishedLiquidVslot64(a) === publishedLiquidVslot64(b) &&
    publishedLiquidVslot6c(a) === publishedLiquidVslot6c(b);
}

export function publishedSurfaceMaterialTypeMatches(
  left: EdgeGraphicsCell | null,
  right: EdgeGraphicsCell | null,
  registry: NativeMaterialAppearanceRegistry,
): boolean {
  if (!left || !right) return false;
  if (left.materialId === right.materialId) return true;
  const a = registry.materialAtInitialId(left.materialId);
  const b = registry.materialAtInitialId(right.materialId);
  if (!a || !b || a.cell_type !== b.cell_type) return false;
  const aIsLiquid = a.cell_type === "liquid";
  const bIsLiquid = b.cell_type === "liquid";
  const aVslot64 = aIsLiquid ? publishedLiquidVslot64(a) : 0;
  const bVslot64 = bIsLiquid ? publishedLiquidVslot64(b) : 0;
  const aVslot6c = aIsLiquid ? publishedLiquidVslot6c(a) : 0;
  const bVslot6c = bIsLiquid ? publishedLiquidVslot6c(b) : 0;
  return aVslot64 === bVslot64 && aVslot6c === bVslot6c;
}

function neighborhood(
  grid: EdgeGraphicsCellGrid,
  registry: NativeMaterialAppearanceRegistry,
  x: number,
  y: number,
): { exactMask: number[]; exactCount: number; compatibleMask: number[]; compatibleCount: number } {
  const anchor = cellAt(grid, x, y);
  const exactMask = new Array<number>(9).fill(0);
  const compatibleMask = new Array<number>(9).fill(0);
  let exactCount = 0;
  let compatibleCount = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const index = (dy + 1) * 3 + dx + 1;
      const candidate = cellAt(grid, x + dx, y + dy);
      if (anchor && candidate?.materialId === anchor.materialId) {
        exactMask[index] = 1;
        compatibleMask[index] = 1;
        exactCount += 1;
        compatibleCount += 1;
      } else if (publishedInteriorMaterialTypeMatches(anchor, candidate, registry)) {
        compatibleMask[index] = 1;
        compatibleCount += 1;
      }
    }
  }
  return { exactMask, exactCount, compatibleMask, compatibleCount };
}

function traceLeavesMaterial(
  grid: EdgeGraphicsCellGrid,
  registry: NativeMaterialAppearanceRegistry,
  anchor: EdgeGraphicsCell,
  x: number,
  y: number,
  vectorX: number,
  vectorY: number,
  requireSameMaterialType: boolean,
): boolean {
  const root = Math.fround(Math.sqrt(Math.fround(vectorX * vectorX + vectorY * vectorY)));
  const stepX = root > 0 ? Math.fround(vectorX / root) : 0;
  const stepY = root > 0 ? Math.fround(vectorY / root) : 0;
  let currentX = Math.fround(x);
  let currentY = Math.fround(y);
  let lastX = Math.trunc(currentX);
  let lastY = Math.trunc(currentY);
  // Native calls this value a count, but compares it to the squared distance
  // travelled. At the production radius of 5, the bound is 25 and the walk
  // therefore samples through distance 5 (not 25 cells).
  const maximumSquaredDistance = Math.min(
    50,
    Math.trunc(Math.fround(Math.fround(root * root) + Math.fround(0.5))),
  );
  let squaredDistance = Math.fround(0);
  while (squaredDistance < maximumSquaredDistance) {
    currentX = Math.fround(currentX + stepX);
    currentY = Math.fround(currentY + stepY);
    const sampleX = Math.trunc(currentX);
    const sampleY = Math.trunc(currentY);
    if (sampleX !== lastX || sampleY !== lastY) {
      const candidate = cellAt(grid, sampleX, sampleY);
      const matches = requireSameMaterialType
        ? publishedSurfaceMaterialTypeMatches(anchor, candidate, registry)
        : candidate?.materialId === anchor.materialId;
      if (!matches) return true;
      lastX = sampleX;
      lastY = sampleY;
    }
    const deltaX = Math.fround(currentX - Math.fround(x));
    const deltaY = Math.fround(currentY - Math.fround(y));
    squaredDistance = Math.fround(
      Math.fround(deltaY * deltaY) + Math.fround(deltaX * deltaX),
    );
  }
  return false;
}

/** Closed 16-probe normal route, projected onto a fresh retained terrain grid. */
export function computeEdgeGraphicsNormalAngle(
  grid: EdgeGraphicsCellGrid,
  registry: NativeMaterialAppearanceRegistry,
  x: number,
  y: number,
  requireSameMaterialType: boolean,
): number | undefined {
  const anchor = cellAt(grid, x, y);
  if (!anchor) return undefined;
  let accumulatedX = Math.fround(0);
  let accumulatedY = Math.fround(0);
  let hits = 0;
  for (let index = 0; index < 16; index += 1) {
    const angle = Math.fround(Math.fround(index) * NORMAL_ANGLE_STEP);
    const cosine = Math.fround(Math.cos(angle));
    const sine = Math.fround(Math.sin(angle));
    const vectorX = Math.fround(-Math.fround(NORMAL_RADIUS * sine));
    const vectorY = Math.fround(NORMAL_RADIUS * cosine);
    if (!traceLeavesMaterial(
      grid, registry, anchor, x, y, vectorX, vectorY, requireSameMaterialType,
    )) continue;
    hits += 1;
    accumulatedX = Math.fround(accumulatedX - vectorX);
    accumulatedY = Math.fround(accumulatedY - vectorY);
  }
  if (hits === 0) return undefined;
  const length = Math.fround(Math.sqrt(Math.fround(
    Math.fround(accumulatedX * accumulatedX) + Math.fround(accumulatedY * accumulatedY),
  )));
  if (!(length > 0)) return undefined;
  let angle = Math.fround(Math.atan2(
    Math.fround(accumulatedY / length),
    Math.fround(accumulatedX / length),
  ));
  if (angle < 0) angle = Math.fround(angle + Math.fround(Math.PI * 2));
  return angle;
}

function colorDefinitionPasses(
  graphics: EdgeGraphicsDefinition,
  masks: ReturnType<typeof neighborhood>,
  random: EdgeGraphicsMinstd,
): boolean {
  if (random.unitF32() > graphics.percent) return false;
  if (!graphics.requireSameMaterial && !graphics.requireSameMaterialType) return true;
  const mask = graphics.requireSameMaterial ? masks.exactMask : masks.compatibleMask;
  return mask[1] + mask[3] + mask[5] + mask[7] === 2 ||
    mask[1] + mask[3] + mask[5] + mask[7] === 3;
}

/**
 * Apply the admitted 512x512 interior edge phase. The caller owns chunk-order
 * RNG scheduling; the default state is the native TLS lazy initializer.
 */
export function applyInteriorEdgeGraphicsChunk(
  grid: EdgeGraphicsCellGrid,
  chunkOriginX: number,
  chunkOriginY: number,
  registry: NativeMaterialAppearanceRegistry,
  inventory: EdgeGraphicsInventory,
  images: ReadonlyMap<string, EdgeGraphicsStampImage>,
  rngState = 39614099,
): EdgeGraphicsChunkResult {
  return runInteriorEdgeGraphicsChunk(
    grid,
    chunkOriginX,
    chunkOriginY,
    registry,
    inventory,
    images,
    rngState,
    "render",
  );
}

/**
 * Advance the interior TLS stream without painting stamp pixels. This is used
 * by schedule-indexed bakers to establish the exact initial state for a later
 * chunk without retaining every preceding 512x512 color plane.
 */
export function consumeInteriorEdgeGraphicsChunkRng(
  grid: EdgeGraphicsCellGrid,
  chunkOriginX: number,
  chunkOriginY: number,
  registry: NativeMaterialAppearanceRegistry,
  inventory: EdgeGraphicsInventory,
  rngState = 39614099,
): EdgeGraphicsChunkResult {
  return runInteriorEdgeGraphicsChunk(
    grid,
    chunkOriginX,
    chunkOriginY,
    registry,
    inventory,
    undefined,
    rngState,
    "consume-rng",
  );
}

function runInteriorEdgeGraphicsChunk(
  grid: EdgeGraphicsCellGrid,
  chunkOriginX: number,
  chunkOriginY: number,
  registry: NativeMaterialAppearanceRegistry,
  inventory: EdgeGraphicsInventory,
  images: ReadonlyMap<string, EdgeGraphicsStampImage> | undefined,
  rngState: number,
  mode: InteriorEdgeGraphicsMode,
): EdgeGraphicsChunkResult {
  if (grid.width !== CHUNK_SIZE || grid.height !== CHUNK_SIZE || grid.cells.length !== CHUNK_SIZE * CHUNK_SIZE) {
    throw new Error("[EdgeGraphics] interior route requires one 512x512 cell grid");
  }
  const definitionsByMaterial = new Map(
    inventory.effectiveMaterials.map((entry) => [entry.materialName, entry.definitions] as const),
  );
  const random = new EdgeGraphicsMinstd(rngState);
  const missingImages = new Set<string>();
  const result: EdgeGraphicsChunkResult = {
    cellsVisited: 0,
    cellsWithGraphics: 0,
    exactGateRejections: 0,
    stampCalls: 0,
    writtenPixels: 0,
    missingImages: [],
    rngInitialState: rngState,
    rngFinalState: rngState,
    rngDraws: 0,
  };
  for (let y = INTERIOR_MARGIN; y < CHUNK_SIZE - INTERIOR_MARGIN; y += 1) {
    for (let x = INTERIOR_MARGIN; x < CHUNK_SIZE - INTERIOR_MARGIN; x += 1) {
      result.cellsVisited += 1;
      const anchor = cellAt(grid, x, y);
      if (!anchor) continue;
      const material = registry.materialAtInitialId(anchor.materialId);
      const definitions = material ? definitionsByMaterial.get(material.id) : undefined;
      if (!definitions) continue;
      result.cellsWithGraphics += 1;
      const masks = neighborhood(grid, registry, x, y);
      if (masks.exactCount >= 8) {
        result.exactGateRejections += 1;
        continue;
      }
      for (const graphics of definitions) {
        result.stampCalls += 1;
        if (graphics.type === "COLOR_EDGE_PIXELS") {
          if (colorDefinitionPasses(graphics, masks, random) && colorEdgeGraphicsCell(anchor, graphics)) {
            result.writtenPixels += 1;
          }
          continue;
        }
        const normalBasedAngle = graphics.type === "NORMAL_BASED"
          ? computeEdgeGraphicsNormalAngle(grid, registry, x, y, graphics.requireSameMaterialType)
          : undefined;
        const selection = selectBoundedEdgeGraphicsStamp(graphics, {
          ...masks,
          localX: x,
          localY: y,
          normalBasedAngle,
        }, random);
        if (selection.status !== "completed" || selection.selectedImageIndex === null) continue;
        const imageDefinition = graphics.images[selection.selectedImageIndex];
        if (mode === "consume-rng") {
          // DrawStamp consumes two flip draws when random rotation is enabled,
          // followed by a transpose draw for non-stripe images. Pixel traversal
          // itself is deterministic and does not touch the TLS stream.
          if (imageDefinition.allowRandomRotation) {
            random.unitF64();
            random.unitF64();
            if (!imageDefinition.doOnlyHorizontalStripe && !imageDefinition.doOnlyVerticalStripe) {
              random.unitF64();
            }
          }
          continue;
        }
        const image = images?.get(imageDefinition.filename);
        if (!image) {
          missingImages.add(imageDefinition.filename);
          continue;
        }
        const draw = drawBoundedEdgeGraphicsStamp(grid, graphics, imageDefinition, image, {
          localX: selection.localX,
          localY: selection.localY,
          chunkOriginX,
          chunkOriginY,
          anchorX: x,
          anchorY: y,
        }, random);
        result.writtenPixels += draw.outcomes.filter((entry) => entry.outcome === "written").length;
      }
    }
  }
  result.missingImages = Array.from(missingImages).sort();
  result.rngFinalState = random.state;
  result.rngDraws = random.drawCount;
  return result;
}

export const PIXEL_SCENE_PRESERVE_MATERIAL = -2;
export const PIXEL_SCENE_AIR_MATERIAL = -1;
export const PIXEL_SCENE_EDGE_STATE_POLICY = "standalone-seed-scene-lcg-minstd-v1";

export interface PixelSceneEdgeGraphicsPlane {
  width: number;
  height: number;
  /** Post-scene material plane. Air is -1. */
  materialIds: Int32Array;
  /** This scene's writes: -2 preserve, -1 air, otherwise material id. */
  stampedMaterialIds: Int32Array;
}

export interface PixelSceneEdgeGraphicsResult {
  cellsVisited: number;
  cellsWithGraphics: number;
  exactGateRejections: number;
  stampCalls: number;
  writtenPixels: number;
  targetPixelsOutsideTile: number;
  missingImages: string[];
  globalLcgInitialState: number;
  globalLcgFinalState: number;
  globalLcgDraws: number;
  tlsMinstdInitialState: number;
  tlsMinstdFinalState: number;
  tlsMinstdDraws: number;
  statePolicy: string;
}

class EdgeGraphicsGlobalLcg {
  state: number;
  drawCount = 0;

  constructor(state: number) {
    this.state = state >>> 0;
  }

  rand15(): number {
    this.state = (Math.imul(this.state, 0x343fd) + 0x269ec3) >>> 0;
    this.drawCount += 1;
    return (this.state >>> 16) & 0x7fff;
  }

  unitF32(): number {
    return Math.fround(Math.fround(this.rand15()) / Math.fround(32767));
  }
}

function mixSceneState(value: number): number {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb352d) >>> 0;
  state ^= state >>> 15;
  state = Math.imul(state, 0x846ca68b) >>> 0;
  state ^= state >>> 16;
  return state >>> 0;
}

export function deriveStandalonePixelSceneEdgeStates(
  worldSeed: number,
  sceneX: number,
  sceneY: number,
  sceneSequence: number,
): { globalLcgState: number; tlsMinstdState: number } {
  const mixed = mixSceneState(
    (worldSeed >>> 0) ^ Math.imul(sceneX | 0, 0x9e3779b1) ^
    Math.imul(sceneY | 0, 0x85ebca77) ^ Math.imul((sceneSequence + 1) | 0, 0xc2b2ae3d),
  );
  const tlsMixed = mixSceneState(mixed ^ 0xa5a5a5a5);
  return {
    globalLcgState: mixed,
    tlsMinstdState: (tlsMixed % (0x7fffffff - 1)) + 1,
  };
}

function scenePlaneCell(materialId: number): EdgeGraphicsCell | null {
  return materialId < 0
    ? null
    : { materialId, visualAabbggrr: 0, markerAabbggrr: 0 };
}

function sceneNeighborhood(
  plane: PixelSceneEdgeGraphicsPlane,
  registry: NativeMaterialAppearanceRegistry,
  x: number,
  y: number,
) {
  const anchorId = plane.materialIds[y * plane.width + x];
  const anchor = scenePlaneCell(anchorId);
  const exactMask = new Array<number>(9).fill(0);
  const compatibleMask = new Array<number>(9).fill(0);
  let exactCount = 0;
  let compatibleCount = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const index = (dy + 1) * 3 + dx + 1;
      const candidateId = plane.materialIds[(y + dy) * plane.width + x + dx];
      const candidate = scenePlaneCell(candidateId);
      if (anchor && candidateId === anchorId) {
        exactMask[index] = 1;
        compatibleMask[index] = 1;
        exactCount += 1;
        compatibleCount += 1;
      } else if (publishedSurfaceMaterialTypeMatches(anchor, candidate, registry)) {
        compatibleMask[index] = 1;
        compatibleCount += 1;
      }
    }
  }
  return { exactMask, exactCount, compatibleMask, compatibleCount };
}

function sceneNormalAngle(
  anchorMaterialId: number,
  worldX: number,
  worldY: number,
  requireSameMaterialType: boolean,
  materialAtWorld: (worldX: number, worldY: number) => number | null,
  registry: NativeMaterialAppearanceRegistry,
): number | undefined {
  const anchor = scenePlaneCell(anchorMaterialId);
  let accumulatedX = Math.fround(0);
  let accumulatedY = Math.fround(0);
  let hits = 0;
  for (let index = 0; index < 16; index += 1) {
    const angle = Math.fround(Math.fround(index) * NORMAL_ANGLE_STEP);
    const vectorX = Math.fround(-Math.fround(NORMAL_RADIUS * Math.fround(Math.sin(angle))));
    const vectorY = Math.fround(NORMAL_RADIUS * Math.fround(Math.cos(angle)));
    const root = Math.fround(Math.sqrt(Math.fround(vectorX * vectorX + vectorY * vectorY)));
    const stepX = root > 0 ? Math.fround(vectorX / root) : 0;
    const stepY = root > 0 ? Math.fround(vectorY / root) : 0;
    let currentX = Math.fround(worldX);
    let currentY = Math.fround(worldY);
    let lastX = Math.trunc(currentX);
    let lastY = Math.trunc(currentY);
    const maximumSquaredDistance = Math.min(50, Math.trunc(Math.fround(root * root) + Math.fround(0.5)));
    let squaredDistance = Math.fround(0);
    let leaves = false;
    while (squaredDistance < maximumSquaredDistance) {
      currentX = Math.fround(currentX + stepX);
      currentY = Math.fround(currentY + stepY);
      const sampleX = Math.trunc(currentX);
      const sampleY = Math.trunc(currentY);
      if (sampleX !== lastX || sampleY !== lastY) {
        const candidateId = materialAtWorld(sampleX, sampleY);
        const matches = requireSameMaterialType
          ? publishedSurfaceMaterialTypeMatches(anchor, scenePlaneCell(candidateId ?? -1), registry)
          : candidateId === anchorMaterialId;
        if (!matches) {
          leaves = true;
          break;
        }
        lastX = sampleX;
        lastY = sampleY;
      }
      const deltaX = Math.fround(currentX - Math.fround(worldX));
      const deltaY = Math.fround(currentY - Math.fround(worldY));
      squaredDistance = Math.fround(Math.fround(deltaY * deltaY) + Math.fround(deltaX * deltaX));
    }
    if (!leaves) continue;
    hits += 1;
    accumulatedX = Math.fround(accumulatedX - vectorX);
    accumulatedY = Math.fround(accumulatedY - vectorY);
  }
  if (hits === 0) return undefined;
  const length = Math.fround(Math.sqrt(Math.fround(
    Math.fround(accumulatedX * accumulatedX) + Math.fround(accumulatedY * accumulatedY),
  )));
  if (!(length > 0)) return undefined;
  let angle = Math.fround(Math.atan2(
    Math.fround(accumulatedY / length),
    Math.fround(accumulatedX / length),
  ));
  if (angle < 0) angle = Math.fround(angle + Math.fround(Math.PI * 2));
  return angle;
}

function packedStampPixel(image: EdgeGraphicsStampImage, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  return (
    image.rgba[offset] |
    (image.rgba[offset + 1] << 8) |
    (image.rgba[offset + 2] << 16) |
    (image.rgba[offset + 3] << 24)
  ) >>> 0;
}

function scenePositiveRemainder(value: number, divisor: number): number {
  const remainder = (value | 0) % divisor;
  return remainder < 0 ? remainder + divisor : remainder;
}

/**
 * PixelScene_GetStatus Step 13 composition over a scene-local material plane.
 * Placement RNG state is a deterministic standalone policy until the native
 * global-LCG/TLS lifecycle is available to the lazy browser renderer.
 */
export function applyPixelSceneEdgeGraphics(
  tileGrid: EdgeGraphicsCellGrid,
  tileOriginX: number,
  tileOriginY: number,
  sceneOriginX: number,
  sceneOriginY: number,
  sceneSequence: number,
  worldSeed: number,
  plane: PixelSceneEdgeGraphicsPlane,
  materialAtWorld: (worldX: number, worldY: number) => number | null,
  registry: NativeMaterialAppearanceRegistry,
  inventory: EdgeGraphicsInventory,
  images: ReadonlyMap<string, EdgeGraphicsStampImage>,
): PixelSceneEdgeGraphicsResult {
  if (
    tileGrid.width !== CHUNK_SIZE || tileGrid.height !== CHUNK_SIZE ||
    tileGrid.cells.length !== CHUNK_SIZE * CHUNK_SIZE ||
    plane.width < 3 || plane.height < 3 ||
    plane.materialIds.length !== plane.width * plane.height ||
    plane.stampedMaterialIds.length !== plane.width * plane.height
  ) throw new Error("[EdgeGraphics] invalid PixelScene edge plane");
  const definitionsByMaterial = new Map(
    inventory.effectiveMaterials.map((entry) => [entry.materialName, entry.definitions] as const),
  );
  const hasStampedEdgeMaterial = plane.stampedMaterialIds.some((materialId) => {
    const material = materialId >= 0 ? registry.materialAtInitialId(materialId) : undefined;
    return !!material && definitionsByMaterial.has(material.id);
  });
  const states = deriveStandalonePixelSceneEdgeStates(worldSeed, sceneOriginX, sceneOriginY, sceneSequence);
  const globalRandom = new EdgeGraphicsGlobalLcg(states.globalLcgState);
  const tlsRandom = new EdgeGraphicsMinstd(states.tlsMinstdState);
  const missingImages = new Set<string>();
  const result: PixelSceneEdgeGraphicsResult = {
    cellsVisited: 0,
    cellsWithGraphics: 0,
    exactGateRejections: 0,
    stampCalls: 0,
    writtenPixels: 0,
    targetPixelsOutsideTile: 0,
    missingImages: [],
    globalLcgInitialState: states.globalLcgState,
    globalLcgFinalState: states.globalLcgState,
    globalLcgDraws: 0,
    tlsMinstdInitialState: states.tlsMinstdState,
    tlsMinstdFinalState: states.tlsMinstdState,
    tlsMinstdDraws: 0,
    statePolicy: PIXEL_SCENE_EDGE_STATE_POLICY,
  };
  if (!hasStampedEdgeMaterial) return result;

  const writeSource = (
    worldX: number,
    worldY: number,
    anchorMaterialId: number,
    graphics: EdgeGraphicsDefinition,
    source: number,
  ) => {
    const localX = worldX - tileOriginX;
    const localY = worldY - tileOriginY;
    if (localX < 0 || localY < 0 || localX >= CHUNK_SIZE || localY >= CHUNK_SIZE) {
      result.targetPixelsOutsideTile += 1;
      return;
    }
    const write = applyEdgeGraphicsSourceColorToCell(
      tileGrid.cells[localY * CHUNK_SIZE + localX], anchorMaterialId, graphics, source,
    );
    if (write.outcome === "written") result.writtenPixels += 1;
  };

  for (let localY = 1; localY < plane.height - 1; localY += 1) {
    for (let localX = 1; localX < plane.width - 1; localX += 1) {
      result.cellsVisited += 1;
      const anchorMaterialId = plane.materialIds[localY * plane.width + localX];
      if (anchorMaterialId < 0) continue;
      const material = registry.materialAtInitialId(anchorMaterialId);
      const definitions = material ? definitionsByMaterial.get(material.id) : undefined;
      if (!definitions) continue;
      result.cellsWithGraphics += 1;
      const masks = sceneNeighborhood(plane, registry, localX, localY);
      if (masks.exactCount >= 8) {
        result.exactGateRejections += 1;
        continue;
      }
      const worldX = sceneOriginX + localX;
      const worldY = sceneOriginY + localY;
      for (const graphics of definitions) {
        result.stampCalls += 1;
        if (globalRandom.unitF32() > graphics.percent) continue;
        const mask = graphics.requireSameMaterial
          ? masks.exactMask
          : graphics.requireSameMaterialType
            ? masks.compatibleMask
            : null;
        const count = graphics.requireSameMaterial ? masks.exactCount : masks.compatibleCount;
        if (mask) {
          const cardinalScore = mask[1] + mask[3] + mask[5] + mask[7];
          if (cardinalScore !== 2 && cardinalScore !== 3) continue;
        } else if (graphics.type !== "COLOR_EDGE_PIXELS") continue;

        if (graphics.type === "COLOR_EDGE_PIXELS") {
          const tileX = worldX - tileOriginX;
          const tileY = worldY - tileOriginY;
          if (tileX < 0 || tileY < 0 || tileX >= CHUNK_SIZE || tileY >= CHUNK_SIZE) {
            result.targetPixelsOutsideTile += 1;
            continue;
          }
          const anchor = tileGrid.cells[tileY * CHUNK_SIZE + tileX];
          if (anchor && colorEdgeGraphicsCell(anchor, graphics)) result.writtenPixels += 1;
          continue;
        }
        if (graphics.images.length === 0) continue;
        let selectedImageIndex = globalRandom.rand15() % graphics.images.length;
        let angle = Math.fround(0);
        if (graphics.type === "NORMAL_BASED") {
          const computed = sceneNormalAngle(
            anchorMaterialId, worldX, worldY, graphics.requireSameMaterialType,
            materialAtWorld, registry,
          );
          if (computed === undefined) continue;
          angle = computed;
        } else if (graphics.type === "CARDINAL_DIRECTIONS") {
          if (count < 8) {
            if (mask?.[0] && mask[3] && mask[6]) angle = Math.fround(Math.PI);
            else if (mask?.[0] && mask[1] && mask[2]) angle = Math.fround(Math.PI * 1.5);
            else if (mask?.[6] && mask[7] && mask[8]) angle = Math.fround(Math.PI * 0.5);
          }
        }
        if (graphics.type === "CARDINAL_DIRECTIONS" || graphics.type === "NORMAL_BASED") {
          let found = false;
          for (let offset = 0; offset < graphics.images.length; offset += 1) {
            const candidate = (selectedImageIndex + offset) % graphics.images.length;
            const definition = graphics.images[candidate];
            if (angle >= definition.minAngle && angle < definition.maxAngle) {
              selectedImageIndex = candidate;
              found = true;
              break;
            }
          }
          if (!found) continue;
        }
        const imageDefinition = graphics.images[selectedImageIndex];
        const image = images.get(imageDefinition.filename);
        if (!image) {
          missingImages.add(imageDefinition.filename);
          continue;
        }
        let drawWorldX = worldX;
        let drawWorldY = worldY;
        if (
          (graphics.type === "CARDINAL_DIRECTIONS" || graphics.type === "NORMAL_BASED") &&
          (imageDefinition.doOnlyHorizontalStripe || imageDefinition.doOnlyVerticalStripe)
        ) {
          const angle135 = Math.fround(Math.PI * 0.75);
          const angle225 = Math.fround(Math.PI * 1.25);
          const angle315 = Math.fround(Math.PI * 1.75);
          if (angle >= angle135 && angle < angle225) drawWorldX += 1;
          else if (angle >= angle225 && angle < angle315) drawWorldY += 1;
        }
        let flipFlags = 0;
        if (imageDefinition.allowRandomRotation) {
          if (tlsRandom.unitF64() > 0.5) flipFlags |= 1;
          if (tlsRandom.unitF64() > 0.5) flipFlags |= 2;
        }
        const sourceAt = (sampleX: number, sampleY: number) => {
          if (flipFlags & 1) sampleX = image.width - sampleX - 1;
          if (flipFlags & 2) sampleY = image.height - sampleY - 1;
          return packedStampPixel(image, sampleX, sampleY);
        };
        if (imageDefinition.doOnlyHorizontalStripe) {
          const baseY = drawWorldY - Math.trunc(image.height / 2);
          const sampleX = scenePositiveRemainder(drawWorldX, image.width);
          for (let row = 0; row < image.height; row += 1) {
            writeSource(drawWorldX, baseY + row, anchorMaterialId, graphics, sourceAt(sampleX, row));
          }
          continue;
        }
        if (imageDefinition.doOnlyVerticalStripe) {
          const baseX = drawWorldX - Math.trunc(image.width / 2);
          const sampleY = scenePositiveRemainder(drawWorldY, image.height);
          for (let column = 0; column < image.width; column += 1) {
            writeSource(baseX + column, drawWorldY, anchorMaterialId, graphics, sourceAt(column, sampleY));
          }
          continue;
        }
        const transposed = imageDefinition.allowRandomRotation && tlsRandom.unitF64() > 0.5;
        const baseX = drawWorldX - Math.trunc((transposed ? image.height : image.width) / 2);
        const baseY = drawWorldY - Math.trunc((transposed ? image.width : image.height) / 2);
        for (let row = 0; row < image.height; row += 1) {
          for (let column = 0; column < image.width; column += 1) {
            writeSource(
              baseX + (transposed ? row : column),
              baseY + (transposed ? column : row),
              anchorMaterialId,
              graphics,
              sourceAt(column, row),
            );
          }
        }
      }
    }
  }
  result.missingImages = Array.from(missingImages).sort();
  result.globalLcgFinalState = globalRandom.state;
  result.globalLcgDraws = globalRandom.drawCount;
  result.tlsMinstdFinalState = tlsRandom.state;
  result.tlsMinstdDraws = tlsRandom.drawCount;
  return result;
}
