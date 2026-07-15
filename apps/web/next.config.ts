import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@otn/domain",
    "@otn/config",
    "@otn/db",
    "@otn/source-sdk",
  ],
};

export default nextConfig;
