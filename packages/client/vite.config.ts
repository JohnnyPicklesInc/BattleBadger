import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/** One stamp per deploy, baked into the bundle and written beside it. */
const BUILD = String(Date.now())

export default defineConfig({
  build: { target: 'es2023' },
  // Baked at build time and identical for everyone served the same deploy.
  // The version number only moves when someone runs `npm run bump`, so two
  // deploys of the same version look identical to the lobby's build check —
  // this is what tells them apart.
  define: { __BB_BUILD__: JSON.stringify(BUILD) },
  plugins: [
    {
      // What the server is serving *now*. Deliberately not precached — the
      // whole point is to reach past the service worker and ask the origin,
      // which is the only thing that knows a newer deploy exists.
      name: 'bb-build-stamp',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'build.json',
          source: JSON.stringify({ build: BUILD }),
        })
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'BattleBadger',
        short_name: 'BattleBadger',
        description: 'Browser lockstep RTS — real-time skirmish battles',
        start_url: '/',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'landscape',
        background_color: '#0c0f14',
        theme_color: '#0c0f14',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Take over as soon as a new build lands, rather than leaving the old
        // bundle serving until every tab is closed — a stale client is a
        // guaranteed desync.
        skipWaiting: true,
        clientsClaim: true,
        // Never intercept the multiplayer API/WebSocket paths.
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
