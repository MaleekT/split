import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },
  webpack(config, { webpack }) {
    // Suppress optional-dep warnings from MetaMask SDK (React Native) and WalletConnect (pino-pretty)
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^(@react-native-async-storage\/async-storage|pino-pretty)$/,
      }),
    )
    return config
  },
}

export default nextConfig
