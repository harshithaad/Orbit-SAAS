import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Enables forbidden() / unauthorized() + forbidden.tsx for clean 403s.
    authInterrupts: true,
  },
};

export default nextConfig;
