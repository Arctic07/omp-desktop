import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  /**
   * The highlighting worker loads one grammar at a time (`code-language-loaders.ts`). The default
   * IIFE worker bundle inlines every dynamic import, which put all ~50 grammars in one 3.6 MB
   * file fetched before the first block is coloured. A module worker keeps them as separate
   * chunks: the worker starts with core + wasm and fetches only the languages a file names.
   */
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  ...(mode === 'development'
    ? {
        server: {
          host: true,
          /**
           * The Tauri window opens on this exact address (`src-tauri/tauri.conf.json` `build.devUrl`),
           * and `strictPort` is what stops this server from silently moving to another port the window
           * would never find.
           */
          port: 1421,
          strictPort: true,
          /**
           * This document must never be framed, and `frame-ancestors` is the one directive a `<meta>`
           * tag cannot carry, so under `vite dev` the header has to come from here (`tauri.conf.json`
           * supplies it for the built application).
           */
          headers: {
            'Content-Security-Policy': "frame-ancestors 'none'",
          },
        },
      }
    : {
        preview: {
          port: 4174,
          headers: {
            'Content-Security-Policy': "frame-ancestors 'none'",
          },
        },
      }),
}))
