import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Server Actions default to a 1mb body limit; manuals routinely run to
    // tens of MB, so the upload action (app/actions.ts:uploadDocument)
    // needs this raised.
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
