import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // zedbar (QR detection) is a WASM-backed Node package that reads its own
  // .wasm file via fs.readFileSync relative to its own compiled JS at
  // require() time. Bundling the route handler leaves that .wasm file
  // behind (bundlers only follow JS import/require graphs, not arbitrary
  // runtime file reads), producing an ENOENT that only surfaces during
  // `next build`'s page-data-collection step. Marking it external makes
  // Next.js require() it directly from node_modules at runtime instead,
  // where the .wasm sits right next to the JS exactly as npm installed it.
  // Same fix as parts-layout-planner's next.config.mjs.
  // better-sqlite3 is a native addon (.node binding) loaded at runtime — the
  // same class of problem as zedbar above, so it is likewise required from
  // node_modules rather than bundled into the server output.
  // @strands-agents/sdk dynamically imports optional providers it ships with
  // (e.g. `import('@aws-sdk/client-s3')` inside a context-offloader plugin the
  // Warehouse Agent never uses). Bundling it makes Turbopack try to resolve
  // every one of those optional peers at build time and report them missing.
  // Marking it external requires it from node_modules at runtime instead, so
  // only the paths actually taken need to resolve — and no unrelated AWS
  // packages have to be installed.
  serverExternalPackages: ["zedbar", "better-sqlite3", "@strands-agents/sdk"],
};

export default nextConfig;
