import type { NativeMaterialAppearanceRegistry } from "./material-appearance";
import {
  consumeInteriorEdgeGraphicsChunkRng,
  type EdgeGraphicsChunkResult,
} from "./edge-graphics-renderer";
import type { EdgeGraphicsCellGrid, EdgeGraphicsInventory } from "./edge-graphics";

export const EDGE_GRAPHICS_TLS_INITIAL_STATE = 39614099;
export const EXPERIMENTAL_EDGE_SCHEDULE_ID = "standalone-canonical-8-worker-round-robin-v1";
export const STANDALONE_EDGE_COORDINATE_SCHEDULE_ID = "standalone-seed-coordinate-minstd-v1";
export const STANDALONE_EDGE_WORKER_COUNT = 8;

export interface EdgeGraphicsChunkCoordinate {
  x: number;
  y: number;
}

// Exact sequence retained by the bounded V2 startup producer. V2 does not yet
// establish the generalized streaming/thread assignment after this prefix.
export const V2_FIRST_WORLD_PUBLICATION_PREFIX: readonly EdgeGraphicsChunkCoordinate[] = [
  { x: -1, y: -2 }, { x: 0, y: -2 }, { x: 1, y: -2 },
  { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 2, y: -1 },
  { x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
  { x: 1, y: 1 },
];

function coordinateKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Experimental deterministic continuation around the first-world focus.
 * Only the leading 12 entries are evidenced as native publication order.
 */
export function buildExperimentalEdgeGraphicsSchedule(
  minimumChunkX: number,
  maximumChunkX: number,
  minimumChunkY: number,
  maximumChunkY: number,
): EdgeGraphicsChunkCoordinate[] {
  const result: EdgeGraphicsChunkCoordinate[] = [];
  const admitted = new Set<string>();
  const add = ({ x, y }: EdgeGraphicsChunkCoordinate) => {
    if (x < minimumChunkX || x > maximumChunkX || y < minimumChunkY || y > maximumChunkY) return;
    const key = coordinateKey(x, y);
    if (admitted.has(key)) return;
    admitted.add(key);
    result.push({ x, y });
  };
  V2_FIRST_WORLD_PUBLICATION_PREFIX.forEach(add);

  const continuation: EdgeGraphicsChunkCoordinate[] = [];
  for (let y = minimumChunkY; y <= maximumChunkY; y += 1) {
    for (let x = minimumChunkX; x <= maximumChunkX; x += 1) {
      if (!admitted.has(coordinateKey(x, y))) continuation.push({ x, y });
    }
  }
  continuation.sort((left, right) => {
    const leftDx = Math.abs(left.x);
    const leftDy = Math.abs(left.y + 1);
    const rightDx = Math.abs(right.x);
    const rightDy = Math.abs(right.y + 1);
    return Math.max(leftDx, leftDy) - Math.max(rightDx, rightDy) ||
      (leftDx + leftDy) - (rightDx + rightDy) ||
      left.y - right.y || left.x - right.x;
  });
  continuation.forEach(add);
  return result;
}

export interface EdgeGraphicsCheckpoint {
  scheduleId: string;
  scheduleIndex: number;
  chunkX: number;
  chunkY: number;
  workerIndex: number;
  workerCount: number;
  stateSource: "worker-replay" | "seed-coordinate-canonical";
  rngInitialState: number;
}

function mixUint32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d) >>> 0;
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b) >>> 0;
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

/**
 * O(1) deterministic standalone phase for chunks outside the bounded worker
 * replay window. It feeds the exact native MINSTD algorithm but is explicitly
 * not a claim about Noita's still-unclosed concurrent worker assignment.
 */
export function deriveStandaloneEdgeGraphicsChunkState(
  worldSeed: number,
  chunkX: number,
  chunkY: number,
): number {
  const mixed = mixUint32(
    (worldSeed >>> 0) ^
    Math.imul(chunkX | 0, 0x9e3779b1) ^
    Math.imul(chunkY | 0, 0x85ebca77) ^
    0x45444745,
  );
  return 1 + (mixed % 0x7ffffffe);
}

export class EdgeGraphicsCheckpointBaker {
  private readonly indexByCoordinate = new Map<string, number>();
  private readonly checkpoints = new Map<number, EdgeGraphicsCheckpoint>();
  private readonly workerStates: number[];
  private nextIndex = 0;

  constructor(
    private readonly schedule: readonly EdgeGraphicsChunkCoordinate[],
    private readonly registry: NativeMaterialAppearanceRegistry,
    private readonly inventory: EdgeGraphicsInventory,
    private readonly gridForChunk: (chunkX: number, chunkY: number) => EdgeGraphicsCellGrid,
    private readonly worldSeed: number,
    private readonly maximumReplayChunks = 96,
    private readonly workerCount = STANDALONE_EDGE_WORKER_COUNT,
  ) {
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      throw new Error(`[EdgeGraphicsSchedule] invalid worker count ${workerCount}`);
    }
    schedule.forEach(({ x, y }, index) => this.indexByCoordinate.set(coordinateKey(x, y), index));
    this.workerStates = new Array(workerCount).fill(EDGE_GRAPHICS_TLS_INITIAL_STATE);
  }

  checkpointFor(chunkX: number, chunkY: number): EdgeGraphicsCheckpoint | null {
    const targetIndex = this.indexByCoordinate.get(coordinateKey(chunkX, chunkY));
    if (targetIndex === undefined) return null;
    if (targetIndex >= this.maximumReplayChunks) {
      const coordinateHash = mixUint32(
        Math.imul(chunkX | 0, 0x27d4eb2d) ^ Math.imul(chunkY | 0, 0x165667b1),
      );
      return {
        scheduleId: STANDALONE_EDGE_COORDINATE_SCHEDULE_ID,
        scheduleIndex: targetIndex,
        chunkX,
        chunkY,
        workerIndex: coordinateHash % this.workerCount,
        workerCount: this.workerCount,
        stateSource: "seed-coordinate-canonical",
        rngInitialState: deriveStandaloneEdgeGraphicsChunkState(this.worldSeed, chunkX, chunkY),
      };
    }
    const cached = this.checkpoints.get(targetIndex);
    if (cached) return cached;
    while (this.nextIndex <= targetIndex) {
      const coordinate = this.schedule[this.nextIndex];
      const workerIndex = this.nextIndex % this.workerCount;
      const checkpoint: EdgeGraphicsCheckpoint = {
        scheduleId: EXPERIMENTAL_EDGE_SCHEDULE_ID,
        scheduleIndex: this.nextIndex,
        chunkX: coordinate.x,
        chunkY: coordinate.y,
        workerIndex,
        workerCount: this.workerCount,
        stateSource: "worker-replay",
        rngInitialState: this.workerStates[workerIndex],
      };
      this.checkpoints.set(this.nextIndex, checkpoint);
      const consumed: EdgeGraphicsChunkResult = consumeInteriorEdgeGraphicsChunkRng(
        this.gridForChunk(coordinate.x, coordinate.y),
        coordinate.x * 512,
        coordinate.y * 512,
        this.registry,
        this.inventory,
        checkpoint.rngInitialState,
      );
      this.workerStates[workerIndex] = consumed.rngFinalState;
      this.nextIndex += 1;
    }
    return this.checkpoints.get(targetIndex)!;
  }
}
