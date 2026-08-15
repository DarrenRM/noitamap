import type { CanonicalMaterialDefinition } from "./material-appearance";
import { stepNativeMinstd } from "./native-minstd";

const FLOAT = new DataView(new ArrayBuffer(4));
const DOUBLE = new DataView(new ArrayBuffer(8));
const f32 = Math.fround;
const fadd = (left: number, right: number) => f32(f32(left) + f32(right));
const fsub = (left: number, right: number) => f32(f32(left) - f32(right));
const fmul = (left: number, right: number) => f32(f32(left) * f32(right));

function f32FromBits(bits: number): number {
  FLOAT.setUint32(0, bits >>> 0, true);
  return FLOAT.getFloat32(0, true);
}

function f64FromBits(high: number, low: number): number {
  DOUBLE.setUint32(0, low >>> 0, true);
  DOUBLE.setUint32(4, high >>> 0, true);
  return DOUBLE.getFloat64(0, true);
}

function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g;
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    result[match[1]] = match[2];
  }
  return result;
}

function asFloat(value: string | undefined, fallback: number): number {
  if (value === undefined) return f32(fallback);
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`[Vegetation] invalid float ${JSON.stringify(value)}`);
  return f32(parsed);
}

function asBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`[Vegetation] invalid boolean ${JSON.stringify(value)}`);
  return parsed !== 0;
}

export interface VegetationComponentDefinition {
  sourceIndex: number;
  isVisual: boolean;
  isGrass: boolean;
  isCeilingPlant: boolean;
  randSeed: number;
  treeWidth: number;
  treeRadiusLow: number;
  treeRadiusHigh: number;
  treeProbability: number;
  treeImageFile: string;
  treeMaterialName: string;
  treeMaterialId: number | null;
  grassRequiresNeighbors: boolean;
  materialOnTopOfName: string;
  materialOnTopOfId: number | null;
}

export interface BiomeVegetationConfiguration {
  biomeName: string;
  sourcePath: string;
  components: VegetationComponentDefinition[];
  unresolvedMaterialNames: string[];
}

export interface GrassOverlayRule {
  componentIndex: number;
  grassRequiresNeighbors: boolean;
  treeMaterialId: number;
  materialOnTopOfId: number;
}

function expandImageRange(component: VegetationComponentDefinition): VegetationComponentDefinition[] {
  // Native skips $[lo-hi] expansion for visual-only entries. Grass records in
  // canonical content use this branch, but non-visual components still affect
  // the shuffled vector order and therefore must be expanded.
  if (component.isVisual || !component.treeImageFile.includes("$")) return [component];
  const firstDollar = component.treeImageFile.indexOf("$");
  const match = /^\$\[(\d+)-(\d+)\]/.exec(component.treeImageFile.slice(firstDollar));
  if (!match || component.treeImageFile.indexOf("$", firstDollar + 1) !== -1) {
    throw new Error(`[Vegetation] unsupported image range ${JSON.stringify(component.treeImageFile)}`);
  }
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (start <= 0 || end <= start || end - start > 9) {
    throw new Error(`[Vegetation] unsupported image range ${JSON.stringify(component.treeImageFile)}`);
  }
  const markerEnd = firstDollar + match[0].length;
  const replace = (index: number) =>
    component.treeImageFile.slice(0, firstDollar) + index + component.treeImageFile.slice(markerEnd);
  const result: VegetationComponentDefinition[] = [];
  for (let index = start; index <= end; index += 1) {
    result.push({
      ...component,
      treeImageFile: replace(index),
      randSeed: index === end
        ? component.randSeed
        : fadd(component.randSeed, f32(index * 501)),
    });
  }
  return result;
}

/** Parse and post-expand the vegetation vector whose order feeds native candidate generation. */
export function parseBiomeVegetationConfiguration(
  xml: string,
  biomeName: string,
  sourcePath: string,
  materials: readonly CanonicalMaterialDefinition[],
): BiomeVegetationConfiguration {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, "");
  const scope = /<Materials\b[^>]*>([\s\S]*?)<\/Materials>/i.exec(withoutComments)?.[1] ?? "";
  const byName = new Map(materials.map((material) => [material.id, material.initial_id] as const));
  const unresolved = new Set<string>();
  const parsed: VegetationComponentDefinition[] = [];
  const expression = /<VegetationComponent\b([^>]*)\/?\s*>/gi;
  let sourceIndex = 0;
  for (let match = expression.exec(scope); match; match = expression.exec(scope)) {
    const value = attributes(match[1]);
    const treeMaterialName = value.tree_material ?? "wood";
    const materialOnTopOfName = value.material_on_top_of ?? "";
    const treeMaterialId = byName.get(treeMaterialName) ?? null;
    const materialOnTopOfId = materialOnTopOfName ? (byName.get(materialOnTopOfName) ?? null) : -1;
    if (treeMaterialId === null && treeMaterialName) unresolved.add(treeMaterialName);
    if (materialOnTopOfId === null && materialOnTopOfName) unresolved.add(materialOnTopOfName);
    const component: VegetationComponentDefinition = {
      sourceIndex,
      isVisual: asBoolean(value.is_visual, false),
      isGrass: asBoolean(value.is_grass, false),
      isCeilingPlant: asBoolean(value.is_ceiling_plant, false),
      randSeed: asFloat(value.rand_seed, 1234),
      treeWidth: asFloat(value.tree_width, 120),
      treeRadiusLow: asFloat(value.tree_radius_low, 0.3),
      treeRadiusHigh: asFloat(value.tree_radius_high, 0.7),
      treeProbability: asFloat(value.tree_probability, 0.7),
      treeImageFile: value.tree_image_file ?? "",
      treeMaterialName,
      treeMaterialId,
      grassRequiresNeighbors: asBoolean(value.grass_requires_neighbors, false),
      materialOnTopOfName,
      materialOnTopOfId,
    };
    parsed.push(...expandImageRange(component));
    sourceIndex += 1;
  }
  return {
    biomeName,
    sourcePath,
    components: parsed,
    unresolvedMaterialNames: Array.from(unresolved).sort(),
  };
}

const MINSTD_TO_UNIT = f64FromBits(0x3e000000, 0x001c5f68);
const FISHER_NEGATIVE_UNIT = f64FromBits(0xbe000000, 0x001c5f68);
const FISHER_THRESHOLD = f64FromBits(0x41dfffff, 0xffc00000);
const WORLD_SCALE = f64FromBits(0x3f63ab43, 0x0f49491f);
const SEED_SCALE = f64FromBits(0x408f4000, 0x00000000);

function cvttsd2si(value: number): number {
  if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648) return -2147483648;
  return Math.trunc(value) | 0;
}

function floorF32(value: number): number {
  let result = Math.trunc(f32(value)) | 0;
  if (f32(result) > value) result = (result - 1) | 0;
  return result;
}

function normalizeDoubleSeed(value: number): number {
  const normalized = value < FISHER_THRESHOLD ? value : value * 0.5;
  return cvttsd2si(normalized);
}

/** Exact BiomeManager+0x30 value derived by its constructor from a world seed. */
export function biomeManagerVegetationSeed(worldSeed: number): number {
  let normalized = worldSeed >>> 0;
  if (!(normalized < 0x7fffffff)) normalized *= 0.5;
  const helper = stepNativeMinstd(cvttsd2si(normalized));
  const offsetSeed = stepNativeMinstd(helper);
  const unit = offsetSeed * MINSTD_TO_UNIT;
  return fadd(fmul(f32(unit), f32FromBits(0x461c3c00)), 1);
}

function shuffleComponentIndices(count: number, rawSeed: number): number[] {
  const indices = Array.from({ length: count }, (_, index) => index);
  if (indices.length < 2) return indices;
  let state = normalizeDoubleSeed((rawSeed | 0) + (rawSeed < 0 ? 2147483648 : 0));
  for (let index = indices.length - 1; index > 0; index -= 1) {
    state = stepNativeMinstd(state);
    const nativeOffset = cvttsd2si(state * FISHER_NEGATIVE_UNIT * (index + 1));
    const selected = Math.min(index, -nativeOffset);
    [indices[index], indices[selected]] = [indices[selected], indices[index]];
  }
  return indices;
}

function periodHashBase(cellX: number, cellY: number): number {
  const inverse71 = f32FromBits(0x3c66c2b4);
  const period71 = f32FromBits(0x428e0000);
  const floorY = floorF32(fmul(cellY, inverse71));
  const floorX = floorF32(fmul(cellX, inverse71));
  const reducedX = fadd(fsub(cellX, fmul(f32(floorX), period71)), f32FromBits(0x41d00000));
  const reducedY = fadd(fsub(cellY, fmul(f32(floorY), period71)), f32FromBits(0x43210000));
  return fmul(fmul(reducedY, reducedY), fmul(reducedX, reducedX));
}

function fract(value: number): number {
  return fsub(value, f32(floorF32(value)));
}

function hashProbability(cellX: number, cellY: number): number {
  return fract(fmul(periodHashBase(cellX, cellY), f32FromBits(0x3a84cd4e)));
}

function hashCenterAndRadius(cellX: number, cellY: number) {
  const base = periodHashBase(cellX, cellY);
  return {
    centerX: fract(fmul(f32FromBits(0x3a89ce48), base)),
    radiusFactor: fract(fmul(f32FromBits(0x3aa32fcf), base)),
  };
}

export interface GrassCandidateResult {
  componentShuffleSeed: number;
  rawCandidatesEmitted: number;
  rules: GrassOverlayRule[];
}

/** Exact grass subset of BiomeMaterials_GenerateVegetationCandidates @ 0x0086D560. */
export function generateGrassOverlayRules(
  configuration: BiomeVegetationConfiguration,
  worldSeed: number,
  worldXStart: number,
  worldXEnd = worldXStart + 512,
): GrassCandidateResult {
  return generateGrassOverlayRulesForBiomeSeed(
    configuration,
    biomeManagerVegetationSeed(worldSeed),
    worldXStart,
    worldXEnd,
  );
}

/** Lower exact boundary used to compare directly with the reconstructed native route. */
export function generateGrassOverlayRulesForBiomeSeed(
  configuration: BiomeVegetationConfiguration,
  biomeSeed: number,
  worldXStart: number,
  worldXEnd = worldXStart + 512,
): GrassCandidateResult {
  const result: GrassCandidateResult = { componentShuffleSeed: 0, rawCandidatesEmitted: 0, rules: [] };
  if (configuration.components.length === 0 || worldXStart >= worldXEnd) return result;
  const localScale = biomeSeed * WORLD_SCALE;
  let shuffleInput = localScale * SEED_SCALE;
  shuffleInput = shuffleInput + (worldXStart | 0);
  shuffleInput = shuffleInput + (worldXEnd | 0);
  shuffleInput = shuffleInput * SEED_SCALE;
  const componentSeed = cvttsd2si(shuffleInput);
  result.componentShuffleSeed = componentSeed >>> 0;
  const admittedGrass = new Set<number>();

  for (const componentIndex of shuffleComponentIndices(configuration.components.length, componentSeed)) {
    const component = configuration.components[componentIndex];
    if (component.treeWidth === 0) continue;
    let cursor = worldXStart | 0;
    while (cursor < (worldXEnd | 0)) {
      const randomOffset = f32(component.randSeed) * localScale;
      const ratio = (randomOffset + cursor) / f32(component.treeWidth);
      const cellX = floorF32(f32(ratio));
      const cellXF32 = f32(cellX);
      if (hashProbability(cellXF32, f32(69)) < component.treeProbability) {
        const sample = hashCenterAndRadius(cellXF32, f32(1612));
        const radius = fadd(
          fmul(fsub(component.treeRadiusHigh, component.treeRadiusLow), sample.radiusFactor),
          component.treeRadiusLow,
        );
        if (radius > 0) {
          let localPosition = fmul(fsub(1, fmul(radius, 2)), sample.centerX);
          localPosition = fadd(localPosition, radius);
          localPosition = fadd(localPosition, cellXF32);
          if (localPosition !== 0) {
            result.rawCandidatesEmitted += 1;
            if (component.isGrass && !component.isCeilingPlant && !admittedGrass.has(componentIndex)) {
              admittedGrass.add(componentIndex);
              if (component.treeMaterialId !== null && component.treeMaterialId > 0) {
                result.rules.push({
                  componentIndex,
                  grassRequiresNeighbors: component.grassRequiresNeighbors,
                  treeMaterialId: component.treeMaterialId,
                  materialOnTopOfId: component.materialOnTopOfId ?? -1,
                });
              }
            }
          }
        }
      }
      cursor += f32(component.treeWidth);
    }
  }
  return result;
}
