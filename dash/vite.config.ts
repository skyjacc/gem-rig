import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

// В разработке фронт живёт на 5173, данные берёт у сервера на 4322.
// В сборке всё отдаёт сам сервер, поэтому пути относительные.
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:4322', changeOrigin: true, ws: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
