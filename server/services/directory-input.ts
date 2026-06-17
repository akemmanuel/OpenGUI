export async function resolveCanonicalDirectoryInput(
  directory: string,
  resolveSafeDirectory: (path: string) => Promise<string>,
  realpath: (path: string) => Promise<string>,
): Promise<{ directory: string; canonicalPath: string }> {
  const path = await resolveSafeDirectory(directory);
  const canonicalPath = await realpath(path);
  return { directory: path, canonicalPath };
}
