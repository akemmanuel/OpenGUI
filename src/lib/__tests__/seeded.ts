/** Tiny deterministic generator for boundary/property tests (not cryptographic). */
export function seeded(seed: number) {
  let state = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return {
    next,
    int(min: number, max: number) {
      return min + (next() % (max - min + 1));
    },
    pick<T>(values: readonly T[]): T {
      return values[next() % values.length]!;
    },
    shuffle<T>(values: readonly T[]): T[] {
      const result = [...values];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const other = next() % (index + 1);
        [result[index], result[other]] = [result[other]!, result[index]!];
      }
      return result;
    },
  };
}

export function bytePartitions(value: string, seed: number): Uint8Array[] {
  const random = seeded(seed);
  const bytes = new TextEncoder().encode(value);
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const length = Math.min(bytes.length - offset, random.int(1, 11));
    result.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return result;
}
