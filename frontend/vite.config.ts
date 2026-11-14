import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// /api/bridge/* -> bridge (7777), /api/agent/* -> agent service (7778). Targets come from .env (VITE_BRIDGE_URL, VITE_AGENT_URL).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const bridge = env.VITE_BRIDGE_URL || 'http://127.0.0.1:7777';
  const agent = env.VITE_AGENT_URL || 'http://127.0.0.1:7778';
  const proxy = {
    '/api/bridge': { target: bridge, changeOrigin: true, ws: true, rewrite: (p: string) => p.replace(/^\/api\/bridge/, '') },
    '/api/agent': { target: agent, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/agent/, '') },
  };
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 3000, strictPort: true, proxy },
    preview: { port: 3000, proxy },
    build: { outDir: 'dist', sourcemap: false },
    test: {
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
