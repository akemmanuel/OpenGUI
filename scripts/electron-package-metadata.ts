interface PackageMetadata {
  name: string;
  version: string;
  type?: string;
  main: string;
  dependencies?: Record<string, string>;
}

export function createElectronRuntimePackage(pkg: PackageMetadata) {
  return {
    name: pkg.name,
    version: pkg.version,
    type: pkg.type,
    main: pkg.main,
    dependencies: pkg.dependencies ?? {},
  };
}

export function packageIdForImport(id: string) {
  const [scopeOrName, packageName] = id.split("/");
  return scopeOrName?.startsWith("@") ? `${scopeOrName}/${packageName}` : scopeOrName;
}
