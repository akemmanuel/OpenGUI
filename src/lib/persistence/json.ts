import { storageParsed, storageRemove, storageSetJSON } from "./storage";

export function readJsonOr<T>(key: string, fallback: T): T {
  return storageParsed<T>(key) ?? fallback;
}

export function persistJsonWhen(key: string, value: unknown, shouldPersist: boolean): void {
  if (shouldPersist) storageSetJSON(key, value);
  else storageRemove(key);
}

export function persistJsonRecord<T>(
  key: string,
  record: Record<string, T>,
  shouldKeep: (value: T) => boolean,
): void {
  const pruned = Object.fromEntries(
    Object.entries(record).filter(([, value]) => shouldKeep(value)),
  );
  persistJsonWhen(key, pruned, Object.keys(pruned).length > 0);
}
