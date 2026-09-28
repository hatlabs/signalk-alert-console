import { defineConfig } from 'vite'

const signalkUrl = process.env.SIGNALK_URL ?? 'http://localhost:3000'

const proxyTo = (ws: boolean) => ({ target: signalkUrl, changeOrigin: true, ws })

export default defineConfig({
  root: 'src',
  base: './',
  publicDir: 'public',
  build: {
    outDir: '../public',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/signalk': proxyTo(true),
      '/skServer': proxyTo(false),
      '/admin': proxyTo(false)
    }
  }
})
