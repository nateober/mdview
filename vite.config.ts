import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: '/markdown/',
  build: {
    outDir: 'dist',
  },
})
