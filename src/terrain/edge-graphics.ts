import { aarrggbbToAabbggrr } from "./material-appearance";
import { NativeMinstd, stepNativeMinstd } from "./native-minstd";

export type EdgeGraphicsType =
  | "COLOR_EDGE_PIXELS"
  | "EVERYWHERE"
  | "CARDINAL_DIRECTIONS"
  | "NORMAL_BASED";

export interface EdgeGraphicsImageDefinition {
  filename: string;
  minAngle: number;
  maxAngle: number;
  doOnlyHorizontalStripe: boolean;
  doOnlyVerticalStripe: boolean;
  allowRandomRotation: boolean;
}

export interface EdgeGraphicsDefinition {
  z: number;
  type: EdgeGraphicsType;
  percent: number;
  requireSameMaterial: boolean;
  requireSameMaterialType: boolean;
  overwrite: boolean;
  packedColorAabbggrr: number;
  images: EdgeGraphicsImageDefinition[];
}

export interface MaterialEdgeGraphicsDefinition {
  materialName: string;
  parentMaterialName: string | null;
  definitions: EdgeGraphicsDefinition[];
}

export interface EdgeGraphicsInventory {
  materials: MaterialEdgeGraphicsDefinition[];
  directRecordCount: number;
  directImageCount: number;
  uniqueImagePaths: string[];
  effectiveMaterials: MaterialEdgeGraphicsDefinition[];
  effectiveRecordCount: number;
  effectiveImageCount: number;
}

const FLOAT = new DataView(new ArrayBuffer(4));

function f32FromBits(bits: number): number {
  FLOAT.setUint32(0, bits >>> 0, true);
  return FLOAT.getFloat32(0, true);
}

function f32Bits(value: number): number {
  FLOAT.setFloat32(0, Math.fround(value), true);
  return FLOAT.getUint32(0, true);
}

const DEGREES_TO_RADIANS_F32 = f32FromBits(0x3c8efa35);

function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g;
  for (let match = expression.exec(text); match; match = expression.exec(text)) result[match[1]] = match[2];
  return result;
}

function asFloat(value: string | undefined, fallback: number): number {
  if (value === undefined) return Math.fround(fallback);
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`[EdgeGraphics] invalid float ${JSON.stringify(value)}`);
  return Math.fround(parsed);
}

function asBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`[EdgeGraphics] invalid boolean ${JSON.stringify(value)}`);
  return parsed !== 0;
}

function asAngleRadians(value: string | undefined): number {
  return Math.fround(asFloat(value, 0) * DEGREES_TO_RADIANS_F32);
}

function asPackedColor(value: string | undefined): number {
  if (value === undefined) return 0xff123123;
  if (!/^[0-9a-f]{8}$/i.test(value)) throw new Error(`[EdgeGraphics] invalid color ${JSON.stringify(value)}`);
  return aarrggbbToAabbggrr(Number.parseInt(value, 16) >>> 0);
}

function asType(value: string | undefined): EdgeGraphicsType {
  const type = value ?? "COLOR_EDGE_PIXELS";
  if (
    type === "COLOR_EDGE_PIXELS" ||
    type === "EVERYWHERE" ||
    type === "CARDINAL_DIRECTIONS" ||
    type === "NORMAL_BASED"
  ) return type;
  // Native maps an unrecognized lexical value to enum zero. Pinned authored
  // content does not use this route, so fail instead of silently weakening it.
  throw new Error(`[EdgeGraphics] unsupported type ${JSON.stringify(type)}`);
}

function parseImage(attributeText: string): EdgeGraphicsImageDefinition {
  const value = attributes(attributeText);
  return {
    filename: value.filename ?? "",
    minAngle: asAngleRadians(value.min_angle),
    maxAngle: asAngleRadians(value.max_angle),
    doOnlyHorizontalStripe: asBoolean(value.do_only_horizontal_stripe, false),
    doOnlyVerticalStripe: asBoolean(value.do_only_vertical_stripe, false),
    allowRandomRotation: asBoolean(value.allow_random_rotation, false),
  };
}

function parseDefinition(attributeText: string, body: string): EdgeGraphicsDefinition {
  const value = attributes(attributeText);
  const imagesScope = /<Images\b[^>]*>([\s\S]*?)<\/Images>/i.exec(body)?.[1] ?? "";
  const images: EdgeGraphicsImageDefinition[] = [];
  const imageExpression = /<Image\b([^>]*)\/?\s*>/gi;
  for (let match = imageExpression.exec(imagesScope); match; match = imageExpression.exec(imagesScope)) {
    images.push(parseImage(match[1]));
  }
  return {
    z: asFloat(value.z, 1),
    type: asType(value.type),
    percent: asFloat(value.percent, 1),
    requireSameMaterial: asBoolean(value.require_same_material, true),
    requireSameMaterialType: asBoolean(value.require_same_material_type, false),
    overwrite: asBoolean(value.overwrite, false),
    packedColorAabbggrr: asPackedColor(value.color),
    images,
  };
}

/**
 * Parse direct authored records and derive the effective parent/child edge
 * vector using the locked Graphics present-scope replacement rule.
 */
export function parseDirectEdgeGraphicsInventory(xml: string): EdgeGraphicsInventory {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, "");
  const materials: MaterialEdgeGraphicsDefinition[] = [];
  const authoredByName = new Map<string, {
    materialName: string;
    parentMaterialName: string | null;
    isChild: boolean;
    graphicsPresent: boolean;
    definitions: EdgeGraphicsDefinition[];
  }>();
  const materialExpression = /<(CellData(?:Child)?)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (let materialMatch = materialExpression.exec(withoutComments); materialMatch; materialMatch = materialExpression.exec(withoutComments)) {
    const materialAttributes = attributes(materialMatch[2]);
    const body = materialMatch[3];
    const graphicsMatch = /<Graphics\b[^>]*>([\s\S]*?)<\/Graphics>/i.exec(body);
    const graphicsBody = graphicsMatch?.[1] ?? "";
    const edgeBody = /<Edge\b[^>]*>([\s\S]*?)<\/Edge>/i.exec(graphicsBody)?.[1] ?? "";
    const definitions: EdgeGraphicsDefinition[] = [];
    const definitionExpression = /<EdgeGraphics\b([^>]*)>([\s\S]*?)<\/EdgeGraphics>/gi;
    for (let match = definitionExpression.exec(edgeBody); match; match = definitionExpression.exec(edgeBody)) {
      definitions.push(parseDefinition(match[1], match[2]));
    }
    const materialName = materialAttributes.name ?? "";
    const parentMaterialName = materialAttributes._parent ?? null;
    if (definitions.length > 0) materials.push({ materialName, parentMaterialName, definitions });
    authoredByName.set(materialName, {
      materialName,
      parentMaterialName,
      isChild: materialMatch[1].toLowerCase() === "celldatachild",
      graphicsPresent: graphicsMatch !== null,
      definitions,
    });
  }

  const effectiveByName = new Map<string, MaterialEdgeGraphicsDefinition>();
  const resolving = new Set<string>();
  const cloneDefinitions = (source: readonly EdgeGraphicsDefinition[]) => source.map((definition) => ({
    ...definition,
    images: definition.images.map((image) => ({ ...image })),
  }));
  const resolveEffective = (materialName: string): MaterialEdgeGraphicsDefinition => {
    const cached = effectiveByName.get(materialName);
    if (cached) return cached;
    if (resolving.has(materialName)) throw new Error(`[EdgeGraphics] cyclic parent chain at ${materialName}`);
    const authored = authoredByName.get(materialName);
    if (!authored) throw new Error(`[EdgeGraphics] unresolved material ${materialName}`);
    resolving.add(materialName);
    let effectiveDefinitions: EdgeGraphicsDefinition[] = [];
    if (authored.isChild) {
      if (!authored.parentMaterialName) throw new Error(`[EdgeGraphics] missing parent for ${materialName}`);
      effectiveDefinitions = cloneDefinitions(resolveEffective(authored.parentMaterialName).definitions);
    }
    // Every present Graphics scope replaces the inherited edge vector, even
    // when it contains no Edge/EdgeGraphics elements.
    if (authored.graphicsPresent) effectiveDefinitions = cloneDefinitions(authored.definitions);
    const effective = {
      materialName,
      parentMaterialName: authored.parentMaterialName,
      definitions: effectiveDefinitions,
    };
    resolving.delete(materialName);
    effectiveByName.set(materialName, effective);
    return effective;
  };
  for (const materialName of authoredByName.keys()) resolveEffective(materialName);

  const definitions = materials.flatMap((material) => material.definitions);
  const imagePaths = definitions.flatMap((definition) => definition.images.map((image) => image.filename));
  const effectiveMaterials = Array.from(effectiveByName.values()).filter((material) => material.definitions.length > 0);
  const effectiveDefinitions = effectiveMaterials.flatMap((material) => material.definitions);
  return {
    materials,
    directRecordCount: definitions.length,
    directImageCount: imagePaths.length,
    uniqueImagePaths: Array.from(new Set(imagePaths)).sort(),
    effectiveMaterials,
    effectiveRecordCount: effectiveDefinitions.length,
    effectiveImageCount: effectiveDefinitions.reduce((sum, definition) => sum + definition.images.length, 0),
  };
}

const f32 = Math.fround;

function colorChannel(color: number, shift: number): number {
  return f32(((color >>> shift) & 0xff) / f32(255));
}

function packedChannel(value: number): number {
  return Math.trunc(f32(f32(value) * f32(255))) & 0xff;
}

/** Exact SSE-ordered packed-color blend used by the bounded edge writer. */
export function blendEdgeGraphicsColors(source: number, destination: number): number {
  const sourceAlpha = colorChannel(source, 24);
  const inverseSourceAlpha = f32(f32(1) - sourceAlpha);
  let result = 0;
  for (const shift of [0, 8, 16]) {
    const sourceTerm = f32(colorChannel(source, shift) * sourceAlpha);
    const destinationTerm = f32(colorChannel(destination, shift) * inverseSourceAlpha);
    result = (result | (packedChannel(f32(sourceTerm + destinationTerm)) << shift)) >>> 0;
  }
  const destinationAlpha = colorChannel(destination, 24);
  const alpha = f32(f32(destinationAlpha + sourceAlpha) - f32(destinationAlpha * sourceAlpha));
  return (result | (packedChannel(alpha) << 24)) >>> 0;
}

/** Marker color retained by the native non-overwrite edge-decoration gate. */
export function adjustEdgeGraphicsMarkerColor(color: number): number {
  const red = color & 0xff;
  return ((color & 0xffffff00) | (red === 0 ? 1 : red - 1)) >>> 0;
}

export const stepEdgeGraphicsMinstd = stepNativeMinstd;
export class EdgeGraphicsMinstd extends NativeMinstd {}

export interface EdgeGraphicsNeighborRequest {
  exactMask: readonly number[];
  exactCount: number;
  compatibleMask: readonly number[];
  compatibleCount: number;
  localX: number;
  localY: number;
  /** Normalized [0,2pi) f32 angle produced by the closed 16-probe route. */
  normalBasedAngle?: number;
}

export interface EdgeGraphicsStampSelectionResult {
  status: "completed" | "unsupported-config-type" | "unsupported-config-domain";
  percentGatePassed: boolean;
  cardinalGatePassed: boolean;
  imageSelected: boolean;
  selectedImageIndex: number | null;
  normalizedAngleF32Bits: number | null;
  localX: number;
  localY: number;
  rngDraws: number;
}

/**
 * Evidence-supported selection half of the bounded first-coalmine stamp route.
 * Pixel traversal and chunk mutation remain a separate pass.
 */
export function selectBoundedEdgeGraphicsStamp(
  graphics: EdgeGraphicsDefinition,
  request: EdgeGraphicsNeighborRequest,
  random: EdgeGraphicsMinstd,
): EdgeGraphicsStampSelectionResult {
  const drawsBegin = random.drawCount;
  const result: EdgeGraphicsStampSelectionResult = {
    status: "completed",
    percentGatePassed: false,
    cardinalGatePassed: false,
    imageSelected: false,
    selectedImageIndex: null,
    normalizedAngleF32Bits: null,
    localX: request.localX | 0,
    localY: request.localY | 0,
    rngDraws: 0,
  };
  const finish = () => {
    result.rngDraws = random.drawCount - drawsBegin;
    return result;
  };

  if (random.unitF32() > graphics.percent) return finish();
  result.percentGatePassed = true;
  if (
    graphics.type !== "EVERYWHERE" &&
    graphics.type !== "CARDINAL_DIRECTIONS" &&
    graphics.type !== "NORMAL_BASED"
  ) {
    result.status = "unsupported-config-type";
    return finish();
  }

  const mask = graphics.requireSameMaterial
    ? request.exactMask
    : graphics.requireSameMaterialType
      ? request.compatibleMask
      : null;
  const count = graphics.requireSameMaterial ? request.exactCount : request.compatibleCount;
  if (!mask || mask.length !== 9 || count < 0 || count > 9) {
    result.status = "unsupported-config-domain";
    return finish();
  }
  const cardinalScore = mask[1] + mask[3] + mask[5] + mask[7];
  if (cardinalScore !== 2 && cardinalScore !== 3) return finish();
  result.cardinalGatePassed = true;
  if (graphics.images.length === 0 || graphics.images.length > 0x7fffffff) {
    result.status = "unsupported-config-domain";
    return finish();
  }

  let selected = random.inclusive(0, graphics.images.length - 1);
  let angle = f32(0);
  if (graphics.type === "NORMAL_BASED") {
    if (request.normalBasedAngle === undefined || !Number.isFinite(request.normalBasedAngle)) {
      result.status = "unsupported-config-domain";
      return finish();
    }
    angle = f32(request.normalBasedAngle);
    result.normalizedAngleF32Bits = f32Bits(angle);
  }
  if (graphics.type === "CARDINAL_DIRECTIONS") {
    let angleBits = 0;
    if (count < 8) {
      if (mask[0] && mask[3] && mask[6]) angleBits = 0x40490fdb;
      else if (mask[0] && mask[1] && mask[2]) angleBits = 0xbfc90fdb;
      else if (mask[6] && mask[7] && mask[8]) angleBits = 0x3fc90fdb;
    }
    angle = f32FromBits(angleBits === 0xbfc90fdb ? 0x4096cbe4 : angleBits);
    result.normalizedAngleF32Bits = f32Bits(angle);
  }
  if (graphics.type === "CARDINAL_DIRECTIONS" || graphics.type === "NORMAL_BASED") {
    let found = false;
    for (let offset = 0; offset < graphics.images.length; offset += 1) {
      const candidate = (selected + offset) % graphics.images.length;
      const image = graphics.images[candidate];
      if (angle >= image.minAngle && angle < image.maxAngle) {
        selected = candidate;
        found = true;
        break;
      }
    }
    if (!found) return finish();
  }

  result.imageSelected = true;
  result.selectedImageIndex = selected;
  const image = graphics.images[selected];
  if (
    (graphics.type === "CARDINAL_DIRECTIONS" || graphics.type === "NORMAL_BASED") &&
    (image.doOnlyHorizontalStripe || image.doOnlyVerticalStripe)
  ) {
    const angle135 = f32FromBits(0x4016cbe4);
    const angle225 = f32FromBits(0x407b53d1);
    const angle315 = f32FromBits(0x40afeddf);
    if (angle >= angle135 && angle < angle225) result.localX = (result.localX + 1) | 0;
    else if (angle >= angle225 && angle < angle315) result.localY = (result.localY + 1) | 0;
  }
  return finish();
}

/** Direct COLOR_EDGE_PIXELS arm shared by the interior and border routes. */
export function colorEdgeGraphicsCell(
  cell: EdgeGraphicsCell,
  graphics: EdgeGraphicsDefinition,
): boolean {
  const previous = cell.visualAabbggrr >>> 0;
  const marker = readEdgeGraphicsMarkerColor(cell);
  if (!graphics.overwrite && marker !== previous) return false;
  const blended = blendEdgeGraphicsColors(graphics.packedColorAabbggrr, previous);
  writeEdgeGraphicsCellColors(cell, blended, adjustEdgeGraphicsMarkerColor(blended));
  return true;
}

export type EdgeGraphicsConcreteType = "liquid" | "gas" | "solid" | "fire";

export interface EdgeGraphicsCell {
  materialId: number;
  visualAabbggrr: number;
  markerAabbggrr: number;
  /** Native concrete leaf. Omitted legacy/test cells retain solid semantics. */
  concreteType?: EdgeGraphicsConcreteType;
}

export interface EdgeGraphicsCellGrid {
  width: number;
  height: number;
  cells: Array<EdgeGraphicsCell | null>;
}

export interface EdgeGraphicsStampImage {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

export type EdgeGraphicsCellWriteOutcome =
  | "written"
  | "transparent-source"
  | "target-out-of-bounds"
  | "empty-target"
  | "different-material"
  | "already-decorated";

export interface EdgeGraphicsCellWriteResult {
  status: "completed" | "unsupported-source-coordinate" | "unsupported-anchor-cell" | "unsupported-grid";
  outcome: EdgeGraphicsCellWriteOutcome | null;
  sourceAabbggrr: number;
  previousAabbggrr: number;
  blendedAabbggrr: number;
  markerAabbggrr: number;
}

export interface EdgeGraphicsCellWriteRequest {
  anchorX: number;
  anchorY: number;
  sampleX: number;
  sampleY: number;
  targetX: number;
  targetY: number;
  flipFlags: number;
}

function cellAt(grid: EdgeGraphicsCellGrid, x: number, y: number): EdgeGraphicsCell | null {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
  return grid.cells[y * grid.width + x] ?? null;
}

function stampPixel(image: EdgeGraphicsStampImage, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  return (
    image.rgba[offset] |
    (image.rgba[offset + 1] << 8) |
    (image.rgba[offset + 2] << 16) |
    (image.rgba[offset + 3] << 24)
  ) >>> 0;
}

function readEdgeGraphicsMarkerColor(cell: EdgeGraphicsCell): number {
  // CGasCell and CFireCell +0x20 both observe the current/variant getter.
  // Liquid and solid leaves retain distinct marker/original color fields.
  return cell.concreteType === "gas" || cell.concreteType === "fire"
    ? cell.visualAabbggrr >>> 0
    : cell.markerAabbggrr >>> 0;
}

function writeEdgeGraphicsCellColors(
  cell: EdgeGraphicsCell,
  blended: number,
  marker: number,
): void {
  if (cell.concreteType === "fire") {
    // CFireCell's +0x24 route reaches the native no-op setter. The call is
    // still reported as a successful edge write, but retained color is not
    // mutated.
    return;
  }
  cell.visualAabbggrr = blended >>> 0;
  // Gas has one physical color field; retaining the current value here also
  // models its marker getter for later non-overwrite gates.
  cell.markerAabbggrr = cell.concreteType === "gas"
    ? blended >>> 0
    : marker >>> 0;
}

export interface EdgeGraphicsSourceColorWrite {
  outcome: EdgeGraphicsCellWriteOutcome;
  previousAabbggrr: number;
  blendedAabbggrr: number;
  markerAabbggrr: number;
}

/** Shared retained-cell write used by local and world-coordinate stamp routes. */
export function applyEdgeGraphicsSourceColorToCell(
  target: EdgeGraphicsCell | null,
  anchorMaterialId: number,
  graphics: EdgeGraphicsDefinition,
  sourceAabbggrr: number,
): EdgeGraphicsSourceColorWrite {
  const result: EdgeGraphicsSourceColorWrite = {
    outcome: "transparent-source",
    previousAabbggrr: 0,
    blendedAabbggrr: 0,
    markerAabbggrr: 0,
  };
  if (sourceAabbggrr === 0) return result;
  if (!target) {
    result.outcome = "empty-target";
    return result;
  }
  if (target.materialId !== anchorMaterialId) {
    result.outcome = "different-material";
    return result;
  }
  result.previousAabbggrr = target.visualAabbggrr >>> 0;
  if (!graphics.overwrite && readEdgeGraphicsMarkerColor(target) !== result.previousAabbggrr) {
    result.outcome = "already-decorated";
    return result;
  }
  result.blendedAabbggrr = blendEdgeGraphicsColors(sourceAabbggrr, result.previousAabbggrr);
  result.markerAabbggrr = adjustEdgeGraphicsMarkerColor(result.blendedAabbggrr);
  writeEdgeGraphicsCellColors(target, result.blendedAabbggrr, result.markerAabbggrr);
  result.outcome = "written";
  return result;
}

export function writeBoundedEdgeGraphicsCellPixel(
  grid: EdgeGraphicsCellGrid,
  graphics: EdgeGraphicsDefinition,
  image: EdgeGraphicsStampImage,
  request: EdgeGraphicsCellWriteRequest,
): EdgeGraphicsCellWriteResult {
  const result: EdgeGraphicsCellWriteResult = {
    status: "completed",
    outcome: null,
    sourceAabbggrr: 0,
    previousAabbggrr: 0,
    blendedAabbggrr: 0,
    markerAabbggrr: 0,
  };
  if (
    grid.width !== 512 || grid.height !== 512 || grid.cells.length !== 512 * 512 ||
    image.width <= 0 || image.height <= 0 || image.rgba.length !== image.width * image.height * 4
  ) {
    result.status = "unsupported-grid";
    return result;
  }
  let sampleX = request.sampleX | 0;
  let sampleY = request.sampleY | 0;
  if (request.flipFlags & 1) sampleX = (image.width - sampleX - 1) | 0;
  if (request.flipFlags & 2) sampleY = (image.height - sampleY - 1) | 0;
  if (sampleX < 0 || sampleY < 0 || sampleX >= image.width || sampleY >= image.height) {
    result.status = "unsupported-source-coordinate";
    return result;
  }
  result.sourceAabbggrr = stampPixel(image, sampleX, sampleY);
  if (result.sourceAabbggrr === 0) {
    result.outcome = "transparent-source";
    return result;
  }
  if ((request.targetX >>> 0) > 0x1ff || (request.targetY >>> 0) > 0x1ff) {
    result.outcome = "target-out-of-bounds";
    return result;
  }
  const anchor = cellAt(grid, request.anchorX, request.anchorY);
  if (!anchor) {
    result.status = "unsupported-anchor-cell";
    return result;
  }
  const write = applyEdgeGraphicsSourceColorToCell(
    cellAt(grid, request.targetX, request.targetY),
    anchor.materialId,
    graphics,
    result.sourceAabbggrr,
  );
  result.outcome = write.outcome;
  result.previousAabbggrr = write.previousAabbggrr;
  result.blendedAabbggrr = write.blendedAabbggrr;
  result.markerAabbggrr = write.markerAabbggrr;
  return result;
}

export interface EdgeGraphicsDrawRequest {
  localX: number;
  localY: number;
  chunkOriginX: number;
  chunkOriginY: number;
  anchorX: number;
  anchorY: number;
}

export interface EdgeGraphicsDrawResult {
  status: "completed" | "unsupported-image" | "unsupported-cell-write";
  flipFlags: number;
  transposed: boolean;
  cellPixelCalls: number;
  rngDraws: number;
  outcomes: EdgeGraphicsCellWriteResult[];
}

function positiveRemainder(value: number, divisor: number): number {
  const remainder = (value | 0) % divisor;
  return remainder < 0 ? remainder + divisor : remainder;
}

/** Bounded first-coalmine stamp traversal and retained 512-cell color mutation. */
export function drawBoundedEdgeGraphicsStamp(
  grid: EdgeGraphicsCellGrid,
  graphics: EdgeGraphicsDefinition,
  imageDefinition: EdgeGraphicsImageDefinition,
  stamp: EdgeGraphicsStampImage,
  request: EdgeGraphicsDrawRequest,
  random: EdgeGraphicsMinstd,
): EdgeGraphicsDrawResult {
  const drawsBegin = random.drawCount;
  const result: EdgeGraphicsDrawResult = {
    status: "completed",
    flipFlags: 0,
    transposed: false,
    cellPixelCalls: 0,
    rngDraws: 0,
    outcomes: [],
  };
  const finish = () => {
    result.rngDraws = random.drawCount - drawsBegin;
    return result;
  };
  if (
    stamp.width <= 0 || stamp.height <= 0 || stamp.width > 160 || stamp.height > 160 ||
    stamp.rgba.length !== stamp.width * stamp.height * 4
  ) {
    result.status = "unsupported-image";
    return finish();
  }
  if (imageDefinition.allowRandomRotation) {
    if (random.unitF64() > 0.5) result.flipFlags |= 1;
    if (random.unitF64() > 0.5) result.flipFlags |= 2;
  }
  const setPixel = (sampleX: number, sampleY: number, targetX: number, targetY: number): boolean => {
    result.cellPixelCalls += 1;
    const write = writeBoundedEdgeGraphicsCellPixel(grid, graphics, stamp, {
      anchorX: request.anchorX,
      anchorY: request.anchorY,
      sampleX,
      sampleY,
      targetX,
      targetY,
      flipFlags: result.flipFlags,
    });
    result.outcomes.push(write);
    return write.status === "completed";
  };

  if (imageDefinition.doOnlyHorizontalStripe) {
    const baseY = (request.localY - Math.trunc(stamp.height / 2)) | 0;
    const sampleX = positiveRemainder((request.chunkOriginX + request.localX) | 0, stamp.width);
    for (let row = 0; row < stamp.height; row += 1) {
      if (!setPixel(sampleX, row, request.localX, (baseY + row) | 0)) {
        result.status = "unsupported-cell-write";
        return finish();
      }
    }
    return finish();
  }
  if (imageDefinition.doOnlyVerticalStripe) {
    const baseX = (request.localX - Math.trunc(stamp.width / 2)) | 0;
    const sampleY = positiveRemainder((request.chunkOriginY + request.localY) | 0, stamp.height);
    for (let column = 0; column < stamp.width; column += 1) {
      if (!setPixel(column, sampleY, (baseX + column) | 0, request.localY)) {
        result.status = "unsupported-cell-write";
        return finish();
      }
    }
    return finish();
  }
  if (imageDefinition.allowRandomRotation) result.transposed = random.unitF64() > 0.5;
  const baseX = (
    request.localX - Math.trunc((result.transposed ? stamp.height : stamp.width) / 2)
  ) | 0;
  const baseY = (
    request.localY - Math.trunc((result.transposed ? stamp.width : stamp.height) / 2)
  ) | 0;
  for (let row = 0; row < stamp.height; row += 1) {
    for (let column = 0; column < stamp.width; column += 1) {
      const targetX = (baseX + (result.transposed ? row : column)) | 0;
      const targetY = (baseY + (result.transposed ? column : row)) | 0;
      if (!setPixel(column, row, targetX, targetY)) {
        result.status = "unsupported-cell-write";
        return finish();
      }
    }
  }
  return finish();
}
