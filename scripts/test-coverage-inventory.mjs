#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputArgument = process.argv.indexOf("--output");
const output = outputArgument >= 0 ? resolve(root, process.argv[outputArgument + 1]) : null;
const sourceRoots = [
  "lib",
  "main",
  "packages/backend/src",
  "packages/harness/src",
  "packages/protocol/src",
  "scripts",
  "server",
  "src",
];
const rootSources = ["main.ts", "preload.ts", "settings-store.ts"];
const extensions = new Set([".ts", ".tsx", ".mjs"]);

function walk(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return walk(child);
    return extensions.has(extname(entry.name)) ? [child] : [];
  });
}

function projectPath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function isTest(path) {
  return /(?:^|\/)(?:test|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(
    projectPath(path),
  );
}

function executable(text, path) {
  if (path.endsWith(".tsx") || path.endsWith(".mjs")) return true;
  const runtime = text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/^\s*\/\/.*$/gmu, "")
    .replaceAll(/^\s*import[\s\S]*?;\s*$/gmu, "")
    .replaceAll(/^\s*export\s+type\s+[\s\S]*?;\s*$/gmu, "")
    .replaceAll(/^\s*(?:export\s+)?interface\s+\w+[\s\S]*?^\}\s*$/gmu, "")
    .trim();
  return /\b(?:function|class|const|let|var|new|await|throw)\b|=>|\w+\s*\(|\bexport\b.*\bfrom\b/u.test(
    runtime,
  );
}

function exportsOf(text) {
  const names = new Set();
  for (const match of text.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/gu,
  ))
    names.add(match[1]);
  for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/gu)) {
    for (const item of match[1].split(",")) {
      const clean = item.trim().replace(/^type\s+/u, "");
      if (!clean || item.trim().startsWith("type ")) continue;
      names.add((clean.split(/\s+as\s+/u)[1] ?? clean.split(/\s+as\s+/u)[0]).trim());
    }
  }
  if (/\bexport\s+default\s+(?!function|class)/u.test(text)) names.add("default");
  return [...names].sort((left, right) => left.localeCompare(right));
}

function routesOf(text) {
  const routes = new Set();
  for (const match of text.matchAll(
    /\.\s*(get|post|put|patch|delete|options|use)\s*\(\s*["'`]([^"'`]+)["'`]/giu,
  )) {
    routes.add(`${match[1].toUpperCase()} ${match[2]}`);
  }
  return [...routes].sort((left, right) => left.localeCompare(right));
}

function transitionsOf(text) {
  const transitions = new Set();
  for (const match of text.matchAll(
    /\b(type|status|state|kind|mode|phase)\s*(?::|===?|!==?)\s*["'`]([\w:-]+)["'`]/gu,
  ))
    transitions.add(`${match[1]}:${match[2]}`);
  for (const match of text.matchAll(
    /\b(?:async\s+)?(set|update|reorder|remove|delete|abort|start|stop|create|append|claim|dispatch|interrupt|prompt|followUp)([A-Z][\w$]*)?\s*\(/gu,
  ))
    transitions.add(`operation:${match[1]}${match[2] ?? ""}`);
  return [...transitions].sort((left, right) => left.localeCompare(right));
}

function importsOf(text, importer) {
  const imports = [];
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu)) {
    const specifier = match[1];
    let base;
    if (specifier.startsWith("@/")) base = resolve(root, "src", specifier.slice(2));
    else if (specifier === "@opengui/harness") base = resolve(root, "packages/harness/src/index");
    else if (specifier === "@opengui/protocol") base = resolve(root, "packages/protocol/src/index");
    else if (specifier.startsWith(".")) base = resolve(dirname(importer), specifier);
    else continue;
    const withoutExtension = base.replace(/\.[cm]?[jt]sx?$/u, "");
    const candidates = [
      base,
      ...[".ts", ".tsx", ".mjs"].map((suffix) => `${withoutExtension}${suffix}`),
      ...[".ts", ".tsx"].map((suffix) => join(withoutExtension, `index${suffix}`)),
    ];
    const found = candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    );
    if (found) imports.push(projectPath(found));
  }
  return [...new Set(imports)];
}

const sources = [
  ...new Set([
    ...sourceRoots.flatMap((path) => walk(resolve(root, path))),
    ...rootSources.map((path) => resolve(root, path)),
  ]),
]
  .filter((path) => !path.endsWith(".d.ts"))
  .filter((path) => !isTest(path))
  .filter((path) => executable(readFileSync(path, "utf8"), path))
  .sort((left, right) => left.localeCompare(right));
const rootFiles = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && extensions.has(extname(entry.name)))
  .map((entry) => resolve(root, entry.name));
const tests = [...sourceRoots.flatMap((path) => walk(resolve(root, path))), ...rootFiles]
  .filter(isTest)
  .filter((path, index, values) => values.indexOf(path) === index)
  .sort((left, right) => left.localeCompare(right));
const all = [...sources, ...tests];
const imports = new Map(
  all.map((path) => [projectPath(path), importsOf(readFileSync(path, "utf8"), path)]),
);
const coveragePath = resolve(root, "coverage/coverage-final.json");
const coverage = existsSync(coveragePath) ? JSON.parse(readFileSync(coveragePath, "utf8")) : {};

function testsReaching(source) {
  const direct = tests
    .filter((test) => imports.get(projectPath(test))?.includes(source))
    .map(projectPath);
  const higher = [];
  for (const test of tests) {
    const seen = new Set();
    const pending = [...(imports.get(projectPath(test)) ?? [])];
    while (pending.length) {
      const next = pending.pop();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      if (next === source) {
        if (!direct.includes(projectPath(test))) higher.push(projectPath(test));
        break;
      }
      pending.push(...(imports.get(next) ?? []));
    }
  }
  return {
    direct,
    higherLevel: [...new Set(higher)].sort((left, right) => left.localeCompare(right)),
  };
}

function runtimeCoverage(path) {
  const item = coverage[resolve(root, path)];
  if (!item) return { available: false, behaviorCoverage: "unknown" };
  const counts = (map) => ({
    observed: Object.values(map).filter((value) => value > 0).length,
    total: Object.keys(map).length,
  });
  return {
    available: true,
    statements: counts(item.s),
    functions: counts(item.f),
    branches: counts(
      Object.fromEntries(
        Object.entries(item.b).flatMap(([id, values]) =>
          values.map((value, index) => [`${id}:${index}`, value]),
        ),
      ),
    ),
    behaviorCoverage: "unknown",
    caveat:
      "Execution counters prove only that instrumented regions ran; they do not prove behavior was asserted.",
  };
}

const inventory = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: { firstPartyExecutableFiles: sources.length, testFiles: tests.length },
  caveats: [
    "Static imports identify direct and higher-level reachability, not assertion quality.",
    "Runtime counters are not treated as behavioral coverage.",
    "Dynamic routes/imports and computed state names require manual review.",
  ],
  files: sources.map((absolute) => {
    const path = projectPath(absolute);
    const text = readFileSync(absolute, "utf8");
    const testReachability = testsReaching(path);
    const testsText = [...testReachability.direct, ...testReachability.higherLevel]
      .map((test) => readFileSync(resolve(root, test), "utf8"))
      .join("\n");
    const mapSymbols = (symbols) =>
      symbols.map((symbol) => ({
        symbol,
        mentionedByTests: [...testReachability.direct, ...testReachability.higherLevel].filter(
          (test) => readFileSync(resolve(root, test), "utf8").includes(symbol),
        ),
      }));
    return {
      path,
      exports: mapSymbols(exportsOf(text)),
      routes: mapSymbols(routesOf(text)),
      stateTransitions: mapSymbols(transitionsOf(text)),
      tests: testReachability,
      hasBehaviorNamedTest:
        /(?:behavior|contract|integration|property|invariant|security|acceptance)/iu.test(
          testsText,
        ),
      runtimeCoverage: runtimeCoverage(path),
    };
  }),
};

const json = `${JSON.stringify(inventory, null, 2)}\n`;
if (output) {
  writeFileSync(output, json);
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["vp", "fmt", output], {
    cwd: root,
    stdio: "ignore",
  });
} else process.stdout.write(json);
