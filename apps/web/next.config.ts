import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source — transpile for Turbopack/webpack
  transpilePackages: [
    "@tempo/editor-core",
    "@tempo/types",
    "@tempo/validators",
  ],
};

export default nextConfig;
