import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// В разработке фронт живёт на 5173, данные берёт у сервера на 4322.
//
// dash/dist — это ЖИВАЯ панель: работающий сервер отдаёт его с диска, и
// сборка туда — развёртывание, без перезапуска. Поэтому обычная сборка
// (npm run build — проверка, CI) пишет в node_modules/.verify-dist, а в
// dash/dist пишет только явное npm run deploy (--outDir dist) — по
// разрешению владельца (CLAUDE.md, план 9, инцидент).
const demo = process.env.VITE_DEMO === '1'

export default defineConfig({
  plugins: [react()],
  // Показ кладётся куда угодно, в том числе в подпапку, поэтому пути
  // относительные. Рабочая сборка отдаётся с корня своим же сервером.
  base: demo ? './' : '/',
  server: {
    proxy: {
      '/api': { target: 'http://localhost:4322', changeOrigin: true, ws: false },
    },
  },
  build: { outDir: demo ? 'dist-demo' : 'node_modules/.verify-dist', emptyOutDir: true },
})
