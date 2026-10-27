/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Served under streetview.bmapsbd.com/v2 — all routes/assets/links get this prefix.
  // Remove this line when v2 replaces v1 at the domain root.
  basePath: "/v2",
  experimental: {
    outputFileTracingRoot: new URL("./", import.meta.url).pathname,
  },
};

export default nextConfig;
