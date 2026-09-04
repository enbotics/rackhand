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
  serverExternalPackages: ["zedbar"],
};

export default nextConfig;
