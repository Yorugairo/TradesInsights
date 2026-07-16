import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@otn/domain",
    "@otn/config",
    "@otn/db",
    "@otn/source-sdk",
    "@otn/intelligence",
    "@otn/resolution",
  ],
  // Workspace packages (and this app's lib/) use NodeNext-style ".js"
  // specifiers that resolve to .ts sources; teach webpack the same trick.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
  },
};

export default nextConfig;
