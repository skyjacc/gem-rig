import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

// В разработке фронт живёт на 5173, данные берёт у сервера на 4322.
// В сборке всё отдаёт сам сервер, поэтому пути относительные.
const demo = process.env.VITE_DEMO === '1'

export default defineConfig({
  plugins: [react(), tailwind()],
  // Показ кладётся куда угодно, в том числе в подпапку, поэтому пути
  // относительные. Рабочая сборка отдаётся с корня своим же сервером.
  base: demo ? './' : '/',
  server: {
    proxy: {
      '/api': { target: 'http://localhost:4322', changeOrigin: true, ws: false },
    },
  },
  build: { outDir: demo ? 'dist-demo' : 'dist', emptyOutDir: true },
})
