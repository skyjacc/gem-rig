import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The build lands inside the Go module so the dashboard is embedded in the
// binary by web/embed.go.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Stamped into the bundle so a diagnostic report says which build produced
  // it. A bug report against an unknown build is not actionable.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // The vendored animated icons import from '@/lib/utils', the path shadcn
  // components expect.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: '../backend/web/dist',
    emptyOutDir: true,
    // The bundle is served from the operator's own machine, but a source map
    // is dead weight in an embedded binary and leaks the whole source tree to
    // anything that can reach the port.
    sourcemap: false,
  },
  server: {
    port: 5177,
    proxy: {
      '/api': 'http://127.0.0.1:3377',
      '/inspect': 'http://127.0.0.1:3377',
    },
  },
})
