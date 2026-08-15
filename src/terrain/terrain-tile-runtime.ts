const RENDERED_TILE_CACHE_BYTES = 48 * 1024 * 1024;

interface TerrainTileRenderJob {
  cancelled: boolean;
  context: any;
  render: () => void;
}

interface RenderedTerrainTileCacheEntry {
  canvas: HTMLCanvasElement;
  bytes: number;
}

class RenderedTerrainTileCache {
  private readonly entries = new Map<string, RenderedTerrainTileCacheEntry>();
  private bytes = 0;
  readonly stats = {
    renders: 0,
    cacheHits: 0,
    cacheEvictions: 0,
    cancellations: 0,
    renderedMs: 0,
  };

  recordRender(durationMs: number): void {
    this.stats.renders += 1;
    this.stats.renderedMs += durationMs;
    scheduleTileStatsPublication();
  }

  recordCancellation(): void {
    this.stats.cancellations += 1;
    scheduleTileStatsPublication();
  }

  get(key: string): HTMLCanvasElement | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.stats.cacheHits += 1;
    scheduleTileStatsPublication();
    return entry.canvas;
  }

  set(key: string, canvas: HTMLCanvasElement): void {
    const bytes = canvas.width * canvas.height * 4;
    const replaced = this.entries.get(key);
    if (replaced) {
      this.entries.delete(key);
      this.bytes -= replaced.bytes;
    }
    this.entries.set(key, { canvas, bytes });
    this.bytes += bytes;
    while (this.bytes > RENDERED_TILE_CACHE_BYTES && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.bytes -= oldest.bytes;
      this.stats.cacheEvictions += 1;
    }
    scheduleTileStatsPublication();
  }

  snapshot() {
    return {
      ...this.stats,
      cacheEntries: this.entries.size,
      cacheBytes: this.bytes,
      cacheBudgetBytes: RENDERED_TILE_CACHE_BYTES,
    };
  }
}

/**
 * Keep expensive reconstructed-tile work in separate browser tasks. JavaScript
 * still renders one tile at a time, but yielding between tiles lets input,
 * animation, and OpenSeadragon's cancellation bookkeeping run between jobs.
 */
class TerrainTileRenderQueue {
  private readonly jobs: TerrainTileRenderJob[] = [];
  private scheduled = false;

  enqueue(context: any, render: () => void): void {
    const job: TerrainTileRenderJob = { cancelled: false, context, render };
    context.userData ??= {};
    context.userData.reconstructedTerrainRenderJob = job;
    this.jobs.push(job);
    this.schedule();
  }

  cancel(context: any): void {
    const job = context.userData?.reconstructedTerrainRenderJob as
      TerrainTileRenderJob | undefined;
    if (job) job.cancelled = true;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => this.runNext(), 0);
  }

  private runNext(): void {
    this.scheduled = false;
    let job: TerrainTileRenderJob | undefined;
    while ((job = this.jobs.shift())?.cancelled) {
      renderedTerrainTileCache.recordCancellation();
    }
    if (!job) return;
    try {
      job.render();
    } catch (error) {
      job.context.fail(
        error instanceof Error ? error.message : String(error),
        null,
      );
    } finally {
      delete job.context.userData.reconstructedTerrainRenderJob;
      if (this.jobs.length > 0) this.schedule();
    }
  }
}

export const renderedTerrainTileCache = new RenderedTerrainTileCache();
export const terrainTileRenderQueue = new TerrainTileRenderQueue();

let tileStatsPublicationTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTileStatsPublication(): void {
  if (
    typeof document === "undefined" ||
    !document.documentElement ||
    tileStatsPublicationTimer !== null
  ) {
    return;
  }
  tileStatsPublicationTimer = setTimeout(() => {
    tileStatsPublicationTimer = null;
    document.documentElement.dataset.reconstructedTerrainTileStats =
      JSON.stringify(renderedTerrainTileCache.snapshot());
  }, 250);
}
