import { describe, expect, it } from "vitest";

import {
  polkaDotNoise,
  polkaHashCenterRadius,
  polkaHashProbability,
  simplexNoise1234,
  simplexNoiseEvaluate,
  wangGradientNoise2d,
  wangValueNoise2d,
} from "../src/terrain/noita-noise";

const floatBuffer = new ArrayBuffer(4);
const floatView = new DataView(floatBuffer);
const doubleBuffer = new ArrayBuffer(8);
const doubleView = new DataView(doubleBuffer);

function f32Bits(value: number): string {
  floatView.setFloat32(0, value, true);
  return floatView.getUint32(0, true).toString(16).padStart(8, "0");
}

function f64Bits(value: number): string {
  doubleView.setFloat64(0, value, true);
  return doubleView.getBigUint64(0, true).toString(16).padStart(16, "0");
}

describe("Noita terrain noise evidence vectors", () => {
  it("matches the binary32 Wang simplex service", () => {
    const vectors: Array<[number, number, string]> = [
      [0, 0, "00000000"],
      [0.1, 0.2, "3ef4c910"],
      [1, 1, "3e8f2e42"],
      [-0.1, -0.2, "bef8c5eb"],
      [-1, 0, "3de7a178"],
      [-1.25, 3.75, "be8f6346"],
      [5, 10, "be91fa31"],
      [896, 358.4, "bed011a4"],
      [12345.678, -9876.543, "3dc487fc"],
    ];
    for (const [x, y, expected] of vectors) expect(f32Bits(simplexNoise1234(x, y)), `${x},${y}`).toBe(expected);
  });

  it("matches the binary64 material-component simplex service", () => {
    const vectors: Array<[number, number, string]> = [
      [0, 0, "0000000000000000"],
      [0.1, 0.2, "bfd2d2a88e86de3d"],
      [1, 1, "bfdc2d58a7ba7b76"],
      [-0.1, -0.2, "3fd2421330344ff0"],
      [-1.25, 3.75, "3fdf5db74375dde9"],
      [5, 10, "3fce1743be77c310"],
      [896, 358.4, "bfcf42608c3c94bc"],
      [12345.678, -9876.543, "3fc58325abeea691"],
    ];
    for (const [x, y, expected] of vectors) expect(f64Bits(simplexNoiseEvaluate(x, y)), `${x},${y}`).toBe(expected);
  });

  it("matches Wang value and gradient noise", () => {
    const vectors: Array<[number, number, string, string]> = [
      [0, 0, "bf6bebec", "00000000"],
      [0.1, 0.2, "bf539744", "be3e9908"],
      [-0.1, -0.2, "bf4e1431", "3e6bfcc8"],
      [12.25, -7.75, "bf16c592", "3e55f900"],
    ];
    for (const [x, y, valueExpected, gradientExpected] of vectors) {
      expect(f32Bits(wangValueNoise2d(x, y)), `value ${x},${y}`).toBe(valueExpected);
      expect(f32Bits(wangGradientNoise2d(x, y)), `gradient ${x},${y}`).toBe(gradientExpected);
    }
  });

  it("matches polka hash probability, center, and radius", () => {
    const vectors: Array<[number, number, string, string, string, string]> = [
      [0, 0, "3f5f0000", "3f508000", "3ee10000", "3f6a0000"],
      [-1, -1, "3f380000", "3f480000", "3f700000", "3f400000"],
      [70, 70, "3f380000", "3f480000", "3f700000", "3f400000"],
      [71, 71, "3f5f0000", "3f508000", "3ee10000", "3f6a0000"],
      [123, -456, "3e000000", "3ec80000", "3eb00000", "3e200000"],
    ];
    for (const [x, y, probability, centerX, centerY, radius] of vectors) {
      expect(f32Bits(polkaHashProbability(x, y)), `probability ${x},${y}`).toBe(probability);
      const centerRadius = polkaHashCenterRadius(x, y);
      expect(centerRadius.map(f32Bits), `center/radius ${x},${y}`).toEqual([centerX, centerY, radius]);
    }
  });

  it("matches finite polka-dot service vectors", () => {
    const vectors: Array<[number, number, boolean, string]> = [
      [0.41, 0.22, false, "3e5735a5c0000000"],
      [0.31, 0.32, false, "3fc0b9a600000000"],
      [0.41, 0.32, false, "3fc4c732e0000000"],
      [0.31, 0.22, true, "3ef0be3ee0000000"],
      [0.11, 0.32, true, "3f842d4f60000000"],
      [0.21, 0.32, true, "3fd72969e0000000"],
    ];
    for (const [x, y, boxed, expected] of vectors) {
      expect(f64Bits(polkaDotNoise(x, y, 0.2, 0.65, boxed, 1)), `${x},${y},${boxed}`).toBe(expected);
    }
  });
});
