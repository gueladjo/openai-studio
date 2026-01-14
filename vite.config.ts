
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, (process as any).cwd(), '');

  // Use relative paths for Electron, absolute for web
  const isElectron = mode === 'electron';
  const base = isElectron ? './' : '/openai-studio/';

  return {
    base,
    plugins: [
      react(),
      // Only enable PWA for web builds
      !isElectron && VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icons/*.png', 'icons/*.svg'],
        manifest: {
          name: 'OpenAI Studio',
          short_name: 'AI Studio',
          description: 'A professional chat interface for OpenAI GPT-5 models',
          theme_color: '#0d1117',
          background_color: '#0d1117',
          display: 'standalone',
          scope: base,
          start_url: base,
          icons: [
            {
              src: `${base}icons/icon-192.png`,
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: `${base}icons/icon-512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ]
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
                },
                cacheableResponse: {
                  statuses: [0, 200]
                }
              }
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
                },
                cacheableResponse: {
                  statuses: [0, 200]
                }
              }
            }
          ]
        }
      })
    ].filter(Boolean),
    define: {
      // For local/Electron builds: include API key from .env for convenience
      // For web builds (GitHub Pages): exclude secrets - users enter via settings UI
      'process.env': JSON.stringify(
        isElectron || mode === 'development'
          ? { NODE_ENV: env.NODE_ENV || mode, OPENAI_API_KEY: env.OPENAI_API_KEY }
          : { NODE_ENV: env.NODE_ENV || mode }
      )
    }
  };
});
