import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const bridge = process.env.BRIDGE_URL ?? 'http://127.0.0.1:7777';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/status': bridge,
      '/log': bridge,
      '/onchain': bridge,
      '/pay': bridge,
      '/chain-sig': bridge,
      '/events': { target: bridge.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
