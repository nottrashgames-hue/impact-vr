import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR only works in a secure context.
//  - Default: `basicSsl` generates a self-signed certificate so the dev server
//    can be opened over HTTPS from a Quest on the same LAN (accept the
//    certificate warning once in Quest Browser).
//  - `--mode http` (npm run dev:http): plain HTTP. Only useful via localhost,
//    which is a secure context — e.g. a desktop browser, or a Quest connected
//    over USB with `adb reverse tcp:5173 tcp:5173`.
export default defineConfig(({ mode }) => ({
  // Relative asset URLs: the build works from any sub-path (GitHub Pages serves it at /<repo>/).
  base: './',
  plugins: mode === 'http' ? [] : [basicSsl()],
  server: {
    host: true, // listen on all interfaces so the headset can reach it
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
    // Public HTTPS via a Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:4173`).
    allowedHosts: ['.trycloudflare.com'],
  },
  build: {
    target: 'es2022',
    // Rapier's compat build ships its WASM inlined as base64 (~4 MB raw, ~1.4 MB gzip).
    chunkSizeWarningLimit: 4500,
    rolldownOptions: {
      output: {
        // Separate vendor chunks so game-code changes don't invalidate the cached engines.
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge/ },
            { name: 'three', test: /node_modules[\\/]three/ },
          ],
        },
      },
    },
  },
}));
