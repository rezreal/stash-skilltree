// Bundles src/index.tsx into plugin/skilltree.js. React and friends come from
// window.PluginApi at runtime and are never bundled.
import * as esbuild from "esbuild";

const options = {
  entryPoints: ["src/index.tsx"],
  outfile: "plugin/skilltree.js",
  bundle: true,
  format: "iife",
  target: "es2020",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  inject: ["src/ui/react-shim.ts"],
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
