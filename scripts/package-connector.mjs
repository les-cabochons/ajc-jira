import path from "node:path";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { create } from "tar";
import { assertConnectorPluginManifest } from "./connector-manifest.mjs";

const pluginRoot = process.cwd();
const manifestPath = path.join(pluginRoot, "plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const packageMetadata = JSON.parse(
  await readFile(path.join(pluginRoot, "package.json"), "utf8"),
);
assertConnectorPluginManifest(manifest);

if (packageMetadata.version !== manifest.version) {
  throw new Error("package.json and plugin.json must declare the same version.");
}

const distDirectory = path.resolve(pluginRoot, "dist");
const entrypointPath = path.resolve(pluginRoot, manifest.entrypoint);
const entrypointRelativeToDist = path.relative(distDirectory, entrypointPath);
if (
  entrypointRelativeToDist.length === 0 ||
  entrypointRelativeToDist.startsWith("..") ||
  path.isAbsolute(entrypointRelativeToDist)
) {
  throw new Error("Connector manifest entrypoint must be a file inside dist.");
}

await access(entrypointPath);
const entrypointStat = await lstat(entrypointPath);
if (
  !entrypointStat.isFile() ||
  entrypointStat.isSymbolicLink() ||
  ![".cjs", ".js", ".mjs"].includes(path.extname(entrypointPath).toLowerCase())
) {
  throw new Error(
    "Connector manifest entrypoint must be a regular compiled JavaScript file.",
  );
}

await writeFile(
  path.join(pluginRoot, "dist", "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  "utf8",
);

const outputDirectory = path.join(pluginRoot, "package");
const outputPath = path.join(
  outputDirectory,
  `${manifest.id}-${manifest.version}.harday-connector`,
);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await create(
  {
    cwd: pluginRoot,
    file: outputPath,
    gzip: true,
    noMtime: true,
    portable: true,
  },
  ["plugin.json", "dist"],
);

process.stdout.write(`${outputPath}\n`);
