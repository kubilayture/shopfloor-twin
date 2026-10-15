const UINT32_RANGE = 2 ** 32;
const GOLDEN_GAMMA = 0x9e3779b9;

const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k));

export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash >>> 0;
}

export function fmix32(value: number): number {
  let h = value >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Xoshiro128StarStar {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;

  constructor([s0, s1, s2, s3]: readonly [number, number, number, number]) {
    if ((s0 | s1 | s2 | s3) === 0) {
      throw new RangeError('xoshiro128** state must not be all zero');
    }
    this.#s0 = s0 >>> 0;
    this.#s1 = s1 >>> 0;
    this.#s2 = s2 >>> 0;
    this.#s3 = s3 >>> 0;
  }

  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.#s1, 5), 7), 9) >>> 0;
    const t = this.#s1 << 9;
    this.#s2 ^= this.#s0;
    this.#s3 ^= this.#s1;
    this.#s1 ^= this.#s2;
    this.#s0 ^= this.#s3;
    this.#s2 ^= t;
    this.#s3 = rotl(this.#s3, 11);
    return result;
  }
}

export interface RandomStream {
  readonly key: string;
  nextUint32(): number;
  nextFloat(): number;
}

class SeededStream implements RandomStream {
  readonly key: string;
  readonly #generator: Xoshiro128StarStar;

  constructor(key: string, generator: Xoshiro128StarStar) {
    this.key = key;
    this.#generator = generator;
  }

  nextUint32(): number {
    return this.#generator.nextUint32();
  }

  nextFloat(): number {
    return this.#generator.nextUint32() / UINT32_RANGE;
  }
}

export function streamState(seed: number, key: string): [number, number, number, number] {
  let z = (fnv1a32(key) ^ fmix32(seed)) >>> 0;
  const next = (): number => {
    z = (z + GOLDEN_GAMMA) >>> 0;
    return fmix32(z);
  };
  // fmix32 is a bijection with fmix32(0) = 0, so at most one word is zero and the state is never all zero.
  return [next(), next(), next(), next()];
}

export class RandomSource {
  readonly seed: number;
  readonly #issued = new Set<string>();

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
      throw new RangeError(`seed must be an integer in [0, 2^32), got ${String(seed)}`);
    }
    this.seed = seed;
  }

  stream(key: string): RandomStream {
    if (key.length === 0) {
      throw new RangeError('stream key must not be empty');
    }
    if (this.#issued.has(key)) {
      throw new RangeError(`stream "${key}" was already issued; each entity needs its own key`);
    }
    this.#issued.add(key);
    return new SeededStream(key, new Xoshiro128StarStar(streamState(this.seed, key)));
  }
}

function hashedUnit(seed: number, keyHash: number, index: number, salt: number): number {
  let h = fmix32((seed ^ keyHash) >>> 0);
  h = fmix32((h + Math.imul(index >>> 0, 0x9e3779b9) + salt) >>> 0);
  h = fmix32((h ^ Math.floor(index / 0x100000000)) >>> 0);
  return (h + 0.5) / UINT32_RANGE;
}

// A pure function of (seed, key, index): telemetry sampled at arbitrary wall-clock moments must not consume a stream.
export function hashedStandardNormal(seed: number, key: string, index: number): number {
  const keyHash = fnv1a32(key);
  const radius = Math.sqrt(-2 * Math.log(hashedUnit(seed, keyHash, index, 0x1b873593)));
  return radius * Math.cos(2 * Math.PI * hashedUnit(seed, keyHash, index, 0x68e31da4));
}
