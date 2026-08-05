import { readFile, writeFile } from "node:fs/promises";

const suffix = process.argv[2];
const suffixPattern = /^[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/;
const stableVersionPattern = /^\d+\.\d+\.\d+$/;

if (typeof suffix !== "string" || !suffixPattern.test(suffix)) {
  throw new Error(
    "Build version suffix must contain only dot-separated alphanumeric identifiers.",
  );
}

const packagePath = new URL("../package.json", import.meta.url);
const manifestPath = new URL("../plugin.json", import.meta.url);
const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (
  typeof packageMetadata.version !== "string" ||
  packageMetadata.version !== manifest.version ||
  !stableVersionPattern.test(packageMetadata.version)
) {
  throw new Error(
    "package.json and plugin.json must declare the same stable base version.",
  );
}

const buildVersion = `${packageMetadata.version}-${suffix}`;
packageMetadata.version = buildVersion;
manifest.version = buildVersion;

await Promise.all([
  writeFile(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`, "utf8"),
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
]);

process.stdout.write(buildVersion);
