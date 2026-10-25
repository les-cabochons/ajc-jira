// How the plugin is bundled for Ajour's sandboxed worker (plugin API 4): one ES
// module, built for the browser. The worker has no Node built-ins, no `Buffer`
// and no `process`, so nothing may resolve to one: esbuild's browser platform
// fails the build if a dependency imports a Node built-in.
export const bundleOptions = {
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  legalComments: "none",
};
