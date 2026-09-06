import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: new URL('./prototype/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
  plugins: [react()],
  publicDir: false,
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { outDir: '../prototype-dist', emptyOutDir: true },
})
