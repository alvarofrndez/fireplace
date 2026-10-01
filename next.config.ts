import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Ambient app: keep the screen free of the development badge too.
  devIndicators: false,
  // Do not generate AGENTS.md / CLAUDE.md in the project root on `next dev`.
  agentRules: false,
};

export default nextConfig;
