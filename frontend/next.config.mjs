/** @type {import('next').NextConfig} */
// 127.0.0.1, а не localhost: в Windows localhost сначала резолвится в IPv6 и прокси тормозит
const backend = process.env.BACKEND_URL || "http://127.0.0.1:8000";

const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // В dev запросы /api проксируются на FastAPI; в Docker это делает Nginx
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default nextConfig;
