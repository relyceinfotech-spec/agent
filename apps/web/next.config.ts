import type { NextConfig } from "next";
import { getApiBaseUrl } from "./app/api-url";

const configuredApiUrl =
  process.env.NEXT_PUBLIC_API_URL?.trim() ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : undefined);
const apiBaseUrl = getApiBaseUrl(configuredApiUrl, process.env.NODE_ENV);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: apiBaseUrl,
  },
};
export default nextConfig;
