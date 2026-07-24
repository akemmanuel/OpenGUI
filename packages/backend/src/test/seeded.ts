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
  };
}
