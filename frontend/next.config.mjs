/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    outputFileTracingRoot: new URL("./", import.meta.url).pathname,
  },
};

export default nextConfig;
