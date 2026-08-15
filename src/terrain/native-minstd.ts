const DOUBLE = new DataView(new ArrayBuffer(8));

function f64FromBits(high: number, low: number): number {
  DOUBLE.setUint32(0, low >>> 0, true);
  DOUBLE.setUint32(4, high >>> 0, true);
  return DOUBLE.getFloat64(0, true);
}

const MINSTD_MODULUS = 0x7fffffff;
const MINSTD_MULTIPLIER = 0x41a7;
const MINSTD_DIVISOR = 0x1f31d;
const MINSTD_POSITIVE_SCALE = f64FromBits(0x3e000000, 0x001c5f68);
const MINSTD_NEGATIVE_SCALE = f64FromBits(0xbe000000, 0x001c5f68);

/** Advances Noita's native MINSTD stream by one draw. */
export function stepNativeMinstd(seed: number): number {
  const signedSeed = seed | 0;
  const quotient = Math.trunc(signedSeed / MINSTD_DIVISOR) | 0;
  let result =
    (Math.imul(signedSeed, MINSTD_MULTIPLIER) -
      Math.imul(quotient, MINSTD_MODULUS)) |
    0;
  if (result <= 0) result = (result + MINSTD_MODULUS) | 0;
  return result;
}

/** Stateful view of the native MINSTD stream shared by reconstructed systems. */
export class NativeMinstd {
  state: number;
  drawCount = 0;

  constructor(state = 39614099) {
    if (!Number.isInteger(state) || state < 1 || state >= MINSTD_MODULUS) {
      throw new Error(`[NativeMinstd] unsupported state ${state}`);
    }
    this.state = state;
  }

  private step(): number {
    this.state = stepNativeMinstd(this.state);
    this.drawCount += 1;
    return this.state;
  }

  unitF32(): number {
    return Math.fround(this.step() * MINSTD_POSITIVE_SCALE);
  }

  unitF64(): number {
    return this.step() * MINSTD_POSITIVE_SCALE;
  }

  inclusive(minimum: number, maximum: number): number {
    const width = maximum - minimum + 1;
    if (
      !Number.isInteger(minimum) ||
      !Number.isInteger(maximum) ||
      maximum < minimum ||
      width > 0x7fffffff
    ) {
      throw new Error(
        `[NativeMinstd] unsupported inclusive range ${minimum}..${maximum}`,
      );
    }
    return (
      (minimum - Math.trunc(width * (this.step() * MINSTD_NEGATIVE_SCALE))) | 0
    );
  }
}
