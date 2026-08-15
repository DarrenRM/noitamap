const SOURCE_PERMUTATION = new Uint8Array([
  151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,
  140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,
  247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,
  57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,
  74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,
  60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,
  65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,
  200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,
  52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,
  207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,
  119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,
  129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,
  218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,
  81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,
  184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,
  222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180,
]);

const SIMPLEX_PERMUTATION = new Uint8Array(512);
for (let index = 0; index < 512; index += 1) SIMPLEX_PERMUTATION[index] = SOURCE_PERMUTATION[index & 0xff];
const SIMPLEX_MOD12 = new Uint8Array(512);
for (let index = 0; index < 512; index += 1) SIMPLEX_MOD12[index] = SIMPLEX_PERMUTATION[index] % 12;

const VALUE_PERMUTATION_SOURCE = new Uint8Array([
  23,125,161,52,103,117,70,37,247,101,203,169,124,126,44,123,
  152,238,145,45,171,114,253,10,192,136,4,157,249,30,35,72,
  175,63,77,90,181,16,96,111,133,104,75,162,93,56,66,240,
  8,50,84,229,49,210,173,239,141,1,87,18,2,198,143,57,
  225,160,58,217,168,206,245,204,199,6,73,60,20,230,211,233,
  94,200,88,9,74,155,33,15,219,130,226,202,83,236,42,172,
  165,218,55,222,46,107,98,154,109,67,196,178,127,158,13,243,
  65,79,166,248,25,224,115,80,68,51,184,128,232,208,151,122,
  26,212,105,43,179,213,235,148,146,89,14,195,28,78,112,76,
  250,47,24,251,140,108,186,190,228,170,183,139,39,188,244,246,
  132,48,119,144,180,138,134,193,82,182,120,121,86,220,209,3,
  91,241,149,85,205,150,113,216,31,100,41,164,177,214,153,231,
  38,71,185,174,97,201,29,95,7,92,54,254,191,118,34,221,
  131,11,163,99,234,81,227,147,156,176,17,142,69,12,110,62,
  27,255,0,194,59,116,242,252,19,21,187,53,207,129,64,135,
  61,40,167,237,102,223,106,159,197,189,215,137,36,32,22,5,
]);

const VALUE_PERMUTATION = new Uint8Array(512);
for (let index = 0; index < 512; index += 1) VALUE_PERMUTATION[index] = VALUE_PERMUTATION_SOURCE[index & 0xff];

const FLOAT_BUFFER = new ArrayBuffer(4);
const FLOAT_VIEW = new DataView(FLOAT_BUFFER);
const DOUBLE_BUFFER = new ArrayBuffer(8);
const DOUBLE_VIEW = new DataView(DOUBLE_BUFFER);

export function floatFromBits(bits: number): number {
  FLOAT_VIEW.setUint32(0, bits >>> 0, true);
  return FLOAT_VIEW.getFloat32(0, true);
}

export function doubleFromBits(bits: bigint): number {
  DOUBLE_VIEW.setBigUint64(0, bits, true);
  return DOUBLE_VIEW.getFloat64(0, true);
}

const fadd = (left: number, right: number) => Math.fround(Math.fround(left) + Math.fround(right));
const fsub = (left: number, right: number) => Math.fround(Math.fround(left) - Math.fround(right));
const fmul = (left: number, right: number) => Math.fround(Math.fround(left) * Math.fround(right));
const fdiv = (left: number, right: number) => Math.fround(Math.fround(left) / Math.fround(right));
const fi32 = (value: number) => Math.fround(value | 0);

function latticeIndex1234(value: number): number {
  let result = Math.trunc(Math.fround(value)) | 0;
  if (!(value > 0)) result = (result - 1) | 0;
  return result;
}

function gradientDot1234(hash: number, x: number, y: number): number {
  const h = hash & 7;
  let u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  if ((h & 1) !== 0) u = -u;
  return fadd(fmul(v, (h & 2) !== 0 ? -2 : 2), u);
}

function corner1234(hash: number, x: number, y: number): number {
  let attenuation = fsub(0.5, fmul(x, x));
  attenuation = fsub(attenuation, fmul(y, y));
  if (0 > attenuation) return 0;
  const squared = fmul(attenuation, attenuation);
  return fmul(gradientDot1234(hash, x, y), fmul(squared, squared));
}

/** Exact binary32 WangNoise_SimplexNoise2D / SimplexNoise1234 service. */
export function simplexNoise1234(inputX: number, inputY: number): number {
  const x = Math.fround(inputX);
  const y = Math.fround(inputY);
  const f2 = floatFromBits(0x3ebb67ae);
  const g2 = floatFromBits(0x3e58658c);
  const twoG2 = floatFromBits(0x3ed8658c);
  const skew = fmul(fadd(x, y), f2);
  const i = latticeIndex1234(fadd(skew, x));
  const j = latticeIndex1234(fadd(skew, y));
  const unskew = fmul(fi32((i + j) | 0), g2);
  const x0 = fsub(x, fsub(fi32(i), unskew));
  const y0 = fsub(y, fsub(fi32(j), unskew));
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = i1 === 1 ? 0 : 1;
  const x1 = fadd(fsub(x0, fi32(i1)), g2);
  const y1 = fadd(fsub(y0, fi32(j1)), g2);
  const x2 = fadd(fsub(x0, 1), twoG2);
  const y2 = fadd(fsub(y0, 1), twoG2);
  const ii = i & 0xff;
  const jj = j & 0xff;
  const hash0 = SIMPLEX_PERMUTATION[ii + SIMPLEX_PERMUTATION[jj]];
  const hash1 = SIMPLEX_PERMUTATION[ii + i1 + SIMPLEX_PERMUTATION[jj + j1]];
  const hash2 = SIMPLEX_PERMUTATION[ii + 1 + SIMPLEX_PERMUTATION[jj + 1]];
  return fmul(fadd(fadd(corner1234(hash1, x1, y1), corner1234(hash0, x0, y0)), corner1234(hash2, x2, y2)), 40);
}

const GRADIENTS64: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0],
  [1, 0], [-1, 0], [0, 1], [0, -1], [0, 1], [0, -1],
];

function floorDouble(value: number): number {
  const truncated = Math.trunc(value) | 0;
  return truncated > value ? (truncated - 1) | 0 : truncated;
}

function corner64(gradientIndex: number, x: number, y: number): number {
  let attenuation = 0.5 - x * x;
  attenuation = attenuation - y * y;
  if (0 > attenuation) return 0;
  const squared = attenuation * attenuation;
  const [gx, gy] = GRADIENTS64[gradientIndex];
  return (gy * y + gx * x) * (squared * squared);
}

/** Exact binary64 SimplexNoise_Evaluate service used by material components. */
export function simplexNoiseEvaluate(x: number, y: number): number {
  const f2 = doubleFromBits(0x3fd76cf5d0b09954n);
  const g2 = doubleFromBits(0x3fcb0cb174df99c8n);
  const skew = (x + y) * f2;
  const i = floorDouble(skew + x);
  const j = floorDouble(skew + y);
  const unskew = ((i + j) | 0) * g2;
  const x0 = x - (i - unskew);
  const y0 = y - (j - unskew);
  const lower = x0 <= y0;
  const i1 = lower ? 0 : 1;
  const j1 = 1 - i1;
  const x1 = x0 - i1 + g2;
  const y1 = y0 - j1 + g2;
  const twoG2 = g2 * 2;
  const x2 = x0 - 1 + twoG2;
  const y2 = y0 - 1 + twoG2;
  const ii = i & 0xff;
  const jj = j & 0xff;
  const gi0 = SIMPLEX_MOD12[ii + SIMPLEX_PERMUTATION[jj]];
  const gi1 = SIMPLEX_MOD12[ii + i1 + SIMPLEX_PERMUTATION[jj + j1]];
  const gi2 = SIMPLEX_MOD12[ii + 1 + SIMPLEX_PERMUTATION[jj + 1]];
  return (corner64(gi1, x1, y1) + corner64(gi0, x0, y0) + corner64(gi2, x2, y2)) * 70;
}

/** Exact four-octave material-selector FBM service. */
export function fbmNoise4Octaves(inputX: number, inputY: number): number {
  const matrix = [
    floatFromBits(0x3f576a94), floatFromBits(0x3f0a511a),
    floatFromBits(0x3f0a511a), floatFromBits(0xbf576a94),
  ];
  let x = Math.fround(inputX);
  let y = Math.fround(inputY);
  let accumulator = fmul(Math.fround(simplexNoiseEvaluate(x, y)), 0.5);
  const advance = (scale: number, later: boolean) => {
    const nextX = fmul(
      later ? fadd(fmul(matrix[2], y), fmul(matrix[0], x)) : fadd(fmul(matrix[0], x), fmul(matrix[2], y)),
      scale,
    );
    const nextY = fmul(
      later ? fadd(fmul(matrix[3], y), fmul(matrix[1], x)) : fadd(fmul(matrix[1], x), fmul(matrix[3], y)),
      scale,
    );
    x = nextX;
    y = nextY;
  };
  advance(floatFromBits(0x400147ae), false);
  accumulator = fadd(fmul(Math.fround(simplexNoiseEvaluate(x, y)), 0.25), accumulator);
  advance(floatFromBits(0x40151eb8), true);
  accumulator = fadd(fmul(Math.fround(simplexNoiseEvaluate(x, y)), 0.125), accumulator);
  advance(floatFromBits(0x4000a3d7), true);
  accumulator = fadd(fmul(Math.fround(simplexNoiseEvaluate(x, y)), 0.0625), accumulator);
  return fdiv(accumulator, 0.9375);
}

function orderedFloorF32(value: number): number {
  const truncated = Math.trunc(Math.fround(value)) | 0;
  return fi32(truncated) > value ? (truncated - 1) | 0 : truncated;
}

function improvedFade(value: number): number {
  let result = fsub(fmul(value, 6), 15);
  result = fadd(fmul(result, value), 10);
  result = fmul(result, value);
  result = fmul(result, value);
  return fmul(result, value);
}

const interpolate = (from: number, to: number, weight: number) => fadd(from, fmul(fsub(to, from), weight));

export function wangValueNoise2d(inputX: number, inputY: number): number {
  const x = Math.fround(inputX);
  const y = Math.fround(inputY);
  const integerX = orderedFloorF32(x);
  const integerY = orderedFloorF32(y);
  const fractionX = fsub(x, fi32(integerX));
  const fractionY = fsub(y, fi32(integerY));
  const y0 = integerY & 0xff;
  const y1 = (integerY + 1) & 0xff;
  const px0 = VALUE_PERMUTATION[integerX & 0xff];
  const px1 = VALUE_PERMUTATION[(integerX + 1) & 0xff];
  const v00 = fdiv(fi32(VALUE_PERMUTATION[px0 + y0]), 255);
  const v01 = fdiv(fi32(VALUE_PERMUTATION[px0 + y1]), 255);
  const v10 = fdiv(fi32(VALUE_PERMUTATION[px1 + y0]), 255);
  const v11 = fdiv(fi32(VALUE_PERMUTATION[px1 + y1]), 255);
  const weightY = improvedFade(fractionY);
  return fmul(fsub(interpolate(interpolate(v00, v01, weightY), interpolate(v10, v11, weightY), improvedFade(fractionX)), 0.5), 2);
}

const WANG_GRADIENTS = [-1,0,1,0,0,-1,0,1,-1,-1,-1,1,1,-1,1,1];

export function wangGradientNoise2d(inputX: number, inputY: number): number {
  const x = Math.fround(inputX);
  const y = Math.fround(inputY);
  const integerX = orderedFloorF32(x);
  const integerY = orderedFloorF32(y);
  const fractionX = fsub(x, fi32(integerX));
  const fractionY = fsub(y, fi32(integerY));
  const fractionX1 = fsub(fractionX, 1);
  const fractionY1 = fsub(fractionY, 1);
  const y0 = integerY & 0xff;
  const y1 = (integerY + 1) & 0xff;
  const px0 = VALUE_PERMUTATION[integerX & 0xff];
  const px1 = VALUE_PERMUTATION[(integerX + 1) & 0xff];
  const hashes = [VALUE_PERMUTATION[px0+y0]&7, VALUE_PERMUTATION[px0+y1]&7, VALUE_PERMUTATION[px1+y0]&7, VALUE_PERMUTATION[px1+y1]&7];
  const dot = (hash: number, dx: number, dy: number) => fadd(fmul(dy, WANG_GRADIENTS[hash*2+1]), fmul(dx, WANG_GRADIENTS[hash*2]));
  const weightY = improvedFade(fractionY);
  return interpolate(
    interpolate(dot(hashes[0], fractionX, fractionY), dot(hashes[1], fractionX, fractionY1), weightY),
    interpolate(dot(hashes[2], fractionX1, fractionY), dot(hashes[3], fractionX1, fractionY1), weightY),
    improvedFade(fractionX),
  );
}

function periodHashBase(cellX: number, cellY: number): number {
  const inv71 = floatFromBits(0x3c66c2b4);
  const period71 = floatFromBits(0x428e0000);
  const floorY = orderedFloorF32(fmul(cellY, inv71));
  const floorX = orderedFloorF32(fmul(cellX, inv71));
  const reducedX = fadd(fsub(cellX, fmul(fi32(floorX), period71)), floatFromBits(0x41d00000));
  const reducedY = fadd(fsub(cellY, fmul(fi32(floorY), period71)), floatFromBits(0x43210000));
  return fmul(fmul(reducedY, reducedY), fmul(reducedX, reducedX));
}

const fract = (value: number) => fsub(value, fi32(orderedFloorF32(value)));

export function polkaHashProbability(cellX: number, cellY: number): number {
  return fract(fmul(periodHashBase(Math.fround(cellX), Math.fround(cellY)), floatFromBits(0x3a84cd4e)));
}

export function polkaHashCenterRadius(cellX: number, cellY: number): [number, number, number] {
  const base = periodHashBase(Math.fround(cellX), Math.fround(cellY));
  return [
    fract(fmul(floatFromBits(0x3a89ce48), base)),
    fract(fmul(floatFromBits(0x3acbdc41), base)),
    fract(fmul(floatFromBits(0x3aa32fcf), base)),
  ];
}

export function polkaDotNoise(
  inputX: number,
  inputY: number,
  radiusLow: number,
  radiusHigh: number,
  boxed: boolean,
  probability: number,
): number {
  const x = Math.fround(inputX);
  const y = Math.fround(inputY);
  const cellY = orderedFloorF32(y);
  const cellX = orderedFloorF32(x);
  const cellXf = fi32(cellX);
  const cellYf = fi32(cellY);
  if (polkaHashProbability(cellXf, cellYf) >= Math.fround(probability)) return 0;
  const fractionX = fsub(x, cellXf);
  const fractionY = fsub(y, cellYf);
  const [centerX, centerY, radiusFactor] = polkaHashCenterRadius(cellXf, cellYf);
  const radius = fadd(fmul(fsub(radiusHigh, radiusLow), radiusFactor), radiusLow);
  if (0 >= radius) return 0;
  const scale = fdiv(2, radius);
  const scaleMinusOne = fsub(scale, 1);
  const scaleMinusTwo = fsub(scale, 2);
  let transformedY = fsub(fmul(fractionY, scale), scaleMinusOne);
  let transformedX = fsub(fmul(fractionX, scale), scaleMinusOne);
  transformedY = fadd(fmul(scaleMinusTwo, centerY), transformedY);
  transformedX = fadd(fmul(scaleMinusTwo, centerX), transformedX);
  const y2 = fmul(transformedY, transformedY);
  const x2 = fmul(transformedX, transformedX);
  let distance: number;
  if (boxed) {
    distance = fadd(fmul(y2, y2), fmul(x2, x2));
    if (distance > 1) return 0;
  } else {
    const radial = fadd(y2, x2);
    distance = radial < 1 ? radial : 1;
  }
  const falloff = fsub(1, distance);
  return fmul(fmul(falloff, falloff), falloff);
}
