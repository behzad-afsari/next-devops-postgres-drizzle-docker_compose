/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // اگر از تصاویر خارجی استفاده می‌کنی، این را هم اضافه کن
  images: {
    remotePatterns: [
      // مثال:
      // { protocol: 'https', hostname: 'example.com' },
    ],
  },
};

module.exports = nextConfig;
