/** @type {import('next').NextConfig} */
const nextConfig = {
  // 单机 MVP：模型调用与 SQLite 都在 Node runtime 内完成，不使用 Edge runtime。
  // 这里留一个空壳，方便后续接 standalone 输出或代理配置。
};

export default nextConfig;
