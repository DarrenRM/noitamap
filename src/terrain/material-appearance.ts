export interface CanonicalMaterialGraphics {
  texture_file: string;
  color: string | null;
  randomize_colors: boolean;
}

export interface CanonicalMaterialDefinition {
  id: string;
  initial_id: number;
  wang_color: string | null;
  wang_noise_percent?: number;
  wang_curvature?: number;
  wang_noise_type?: number;
  cell_type?: string;
  platform_type?: number;
  liquid_static?: boolean;
  liquid_sand?: boolean;
  liquid_sand_never_box2d?: boolean;
  liquid_sticks_to_ceiling?: number;
  graphics: CanonicalMaterialGraphics;
}

export interface MaterialTexture {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

export type MaterialAppearanceResult =
  | {
      status: "sampled";
      material: CanonicalMaterialDefinition;
      packedAabbggrr: number;
    }
  | { status: "air" }
  | { status: "unknown-material"; materialId: number }
  | {
      status: "missing-texture";
      material: CanonicalMaterialDefinition;
      texturePath: string;
    };

function parseAarrggbb(value: string | null): number | null {
  if (!value || !/^[0-9a-f]{8}$/i.test(value)) return null;
  return Number.parseInt(value, 16) >>> 0;
}

/** Convert XML/JSON AARRGGBB into the native cell color word AABBGGRR. */
export function aarrggbbToAabbggrr(value: number): number {
  const alpha = value & 0xff000000;
  const red = (value >>> 16) & 0xff;
  const green = (value >>> 8) & 0xff;
  const blue = value & 0xff;
  return (alpha | (blue << 16) | (green << 8) | red) >>> 0;
}

export function writeAabbggrr(
  rgba: Uint8Array | Uint8ClampedArray,
  offset: number,
  packed: number,
): void {
  rgba[offset] = packed & 0xff;
  rgba[offset + 1] = (packed >>> 8) & 0xff;
  rgba[offset + 2] = (packed >>> 16) & 0xff;
  rgba[offset + 3] = (packed >>> 24) & 0xff;
}

function arithmeticShiftRight(value: number, count: number): number {
  return (value | 0) >> count;
}

function hashedCoordinate(value: number, shiftCount: number): number {
  let state = value >>> 0;
  state =
    (Math.imul((arithmeticShiftRight(state, 13) ^ state) >>> 0, 0x343fd) +
      0x269ec3) >>>
    0;
  const extracted = (arithmeticShiftRight(state, shiftCount) ^ state) & 0x7fff;
  return Math.trunc((extracted - 0x3fff) / 64) | 0;
}

/** Exact coordinate hashing used by CellFactory_GetVariantColor @ 0x007044A0. */
export function randomizeMaterialTextureCoordinates(
  x: number,
  y: number,
): [number, number] {
  const originalX = x >>> 0;
  const originalY = y >>> 0;
  const first =
    (Math.imul(originalY, 0x5b) + 0x37e40765 + originalX + 0x0d) >>> 0;
  const randomizedX = hashedCoordinate(first, ((originalX + 0x0d) & 0x0f) + 1);

  const second = (originalY + 0x9eec9ad6 + Math.imul(randomizedX, 0x5b)) >>> 0;
  const randomizedY = hashedCoordinate(second, ((originalY + 5) & 0x0f) + 1);
  return [randomizedX, randomizedY];
}

function wrap(value: number, extent: number): number {
  const remainder = value % extent;
  return remainder < 0 ? remainder + extent : remainder;
}

export class NativeMaterialAppearanceRegistry {
  private readonly byInitialId = new Map<number, CanonicalMaterialDefinition>();
  private readonly byName = new Map<string, CanonicalMaterialDefinition>();
  private readonly byWangRgb = new Map<number, CanonicalMaterialDefinition[]>();

  constructor(
    materials: readonly CanonicalMaterialDefinition[],
    private readonly textures: ReadonlyMap<string, MaterialTexture>,
  ) {
    for (const material of materials) {
      this.byName.set(material.id, material);
      if (material.initial_id >= 0)
        this.byInitialId.set(material.initial_id, material);
      const wang = parseAarrggbb(material.wang_color);
      if (wang === null) continue;
      const rgb = wang & 0xffffff;
      const matches = this.byWangRgb.get(rgb) ?? [];
      matches.push(material);
      this.byWangRgb.set(rgb, matches);
    }
  }

  materialAtInitialId(
    initialId: number,
  ): CanonicalMaterialDefinition | undefined {
    return this.byInitialId.get(initialId);
  }

  materialByName(name: string): CanonicalMaterialDefinition | undefined {
    return this.byName.get(name);
  }

  materialsAtWangRgb(rgb: number): readonly CanonicalMaterialDefinition[] {
    return this.byWangRgb.get(rgb & 0xffffff) ?? [];
  }

  sample(
    materialId: number,
    worldX: number,
    worldY: number,
    airMaterialId = 0xffff,
  ): MaterialAppearanceResult {
    if (materialId === airMaterialId) return { status: "air" };
    const material = this.byInitialId.get(materialId);
    if (!material) return { status: "unknown-material", materialId };

    const texturePath = material.graphics.texture_file;
    if (!texturePath) {
      const authored = parseAarrggbb(material.graphics.color);
      return {
        status: "sampled",
        material,
        packedAabbggrr: authored === null ? 0 : aarrggbbToAabbggrr(authored),
      };
    }

    const texture = this.textures.get(texturePath);
    if (!texture) return { status: "missing-texture", material, texturePath };
    if (
      texture.width <= 0 ||
      texture.height <= 0 ||
      texture.rgba.length < texture.width * texture.height * 4
    ) {
      return { status: "missing-texture", material, texturePath };
    }

    let sampleX = worldX | 0;
    let sampleY = worldY | 0;
    if (material.graphics.randomize_colors) {
      [sampleX, sampleY] = randomizeMaterialTextureCoordinates(
        sampleX,
        sampleY,
      );
    }
    sampleX = wrap(sampleX, texture.width);
    sampleY = wrap(sampleY, texture.height);
    const offset = (sampleY * texture.width + sampleX) * 4;
    const red = texture.rgba[offset];
    const green = texture.rgba[offset + 1];
    const blue = texture.rgba[offset + 2];
    const alpha = texture.rgba[offset + 3];
    return {
      status: "sampled",
      material,
      packedAabbggrr: ((alpha << 24) | (blue << 16) | (green << 8) | red) >>> 0,
    };
  }
}
