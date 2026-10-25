// Builds dist/plugin.js, the entrypoint plugin.json names. See bundle-options.mjs.
import { rm } from "node:fs/promises";
import { build, context } from "esbuild";
import { bundleOptions } from "./bundle-options.mjs";

const options = { ...bundleOptions, outfile: "dist/plugin.js", logLevel: "info" };

if (process.argv.includes("--watch")) {
  const watcher = await context(options);
  await watcher.watch();
} else {
  await rm("dist", { recursive: true, force: true });
  await build(options);
}
