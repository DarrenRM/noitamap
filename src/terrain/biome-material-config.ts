import type { CanonicalMaterialDefinition } from "./material-appearance";
import type {
  BiomeMaterialsConfiguration,
  MaterialComponentSelectionRecord,
  MaterialPolygonPoint,
} from "./wang-type2";

const asFloat = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return Math.fround(fallback);
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid native float value ${JSON.stringify(value)}`);
  return Math.fround(parsed);
};

const asInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback | 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid native integer value ${JSON.stringify(value)}`);
  return parsed | 0;
};

const asBoolean = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : asInteger(value, fallback ? 1 : 0) !== 0;

function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g;
  for (let match = expression.exec(text); match; match = expression.exec(text)) result[match[1]] = match[2];
  return result;
}

function parsePolygon(body: string): MaterialPolygonPoint[] {
  const polygon = /<polygon\b[^>]*>([\s\S]*?)<\/polygon>/i.exec(body)?.[1];
  if (!polygon) return [];
  const points: MaterialPolygonPoint[] = [];
  const expression = /<Vec2\b([^>]*)\/?\s*>/gi;
  for (let match = expression.exec(polygon); match; match = expression.exec(polygon)) {
    const values = attributes(match[1]);
    points.push({ x: asFloat(values.x, 0), y: asFloat(values.y, 0) });
  }
  return points;
}

function readRecord(attributeText: string, body: string): MaterialComponentSelectionRecord {
  const value = attributes(attributeText);
  return {
    materialName: value.material_name ?? "",
    materialId: null,
    materialIndex: asInteger(value.material_index, 10),
    materialMin: asFloat(value.material_min, 0.1),
    materialMax: asFloat(value.material_max, 0.1),
    addPerlin: asBoolean(value.add_perlin, false),
    addPerlinScaleX: asFloat(value.add_perlin_scale_x, 1),
    addPerlinScaleY: asFloat(value.add_perlin_scale_y, 1),
    isRare: asBoolean(value.is_rare, false),
    limitY: asBoolean(value.limit_y, false),
    limitMinY: asFloat(value.limit_min_y, 100),
    limitMaxY: asFloat(value.limit_max_y, 2048),
    rareUsePerlin: asBoolean(value.rare_use_perlin, false),
    rareUseFbmPerlin: asBoolean(value.rare_use_fbm_perlin, false),
    rareUsePolka: asBoolean(value.rare_use_polka, true),
    rareScaleX: asFloat(value.rare_scale_x, 0.05),
    rareScaleY: asFloat(value.rare_scale_y, 0.05),
    rareOffsetBySeed: asBoolean(value.rare_offset_by_seed, false),
    rareOffsetX: asFloat(value.rare_offset_x, 0),
    rareOffsetY: asFloat(value.rare_offset_y, 0),
    rarePolkaRadiusLow: asFloat(value.rare_polka_radius_low, 0.2),
    rarePolkaRadiusHigh: asFloat(value.rare_polka_radius_high, 0.65),
    rarePolkaIsBoxed: asBoolean(value.rare_polka_is_boxed, true),
    rarePolkaProbability: asFloat(value.rare_polka_probability, 0.2),
    rareRequiredMin: asFloat(value.rare_required_min, 0.2),
    rareRequiredMax: asFloat(value.rare_required_max, 1),
    isPolygon: asBoolean(value.is_polygon, false),
    polygon: parsePolygon(body),
  };
}

/** Parse the exact MaterialComponent constructor/XML fields consumed by the native selector. */
export function parseBiomeMaterialsConfiguration(
  xml: string,
  biomeName: string,
  sourcePath: string,
  materials: readonly CanonicalMaterialDefinition[],
): BiomeMaterialsConfiguration {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, "");
  const scope = /<Materials\b[^>]*>([\s\S]*?)<\/Materials>/i.exec(withoutComments)?.[1] ?? "";
  const records: MaterialComponentSelectionRecord[] = [];
  const expression = /<MaterialComponent\b([^>]*)>([\s\S]*?)<\/MaterialComponent>/gi;
  for (let match = expression.exec(scope); match; match = expression.exec(scope)) records.push(readRecord(match[1], match[2]));

  // Native first-load completion uses its stable small insertion sort before name resolution.
  records.sort((left, right) => left.materialIndex - right.materialIndex);
  const byName = new Map(materials.map((material) => [material.id, material]));
  const unresolvedMaterialNames = new Set<string>();
  let aggregateMaterialMin = Number.MAX_VALUE;
  let aggregateMaterialMax = -Number.MAX_VALUE;
  for (const record of records) {
    const material = byName.get(record.materialName);
    record.materialId = material?.initial_id ?? null;
    if (!material) {
      if (record.materialName) unresolvedMaterialNames.add(record.materialName);
      continue;
    }
    if (aggregateMaterialMin > record.materialMin) aggregateMaterialMin = record.materialMin;
    if (record.materialMax > aggregateMaterialMax) aggregateMaterialMax = record.materialMax;
  }
  return {
    biomeName,
    sourcePath,
    aggregateMaterialMin: Math.fround(aggregateMaterialMin),
    aggregateMaterialMax: Math.fround(aggregateMaterialMax),
    records,
    unresolvedMaterialNames: Array.from(unresolvedMaterialNames).sort(),
  };
}

export function findBiomeConfigurationPath(paths: readonly string[], biomeName: string): string | null {
  const preferred = [
    `data/biome/${biomeName}.xml`,
    `data/biome/tower/${biomeName}.xml`,
    `data/biome_impl/static_tile/${biomeName}.xml`,
  ];
  for (const path of preferred) if (paths.includes(path)) return path;
  const suffix = `/${biomeName}.xml`;
  return paths.find((path) => path.endsWith(suffix)) ?? null;
}
