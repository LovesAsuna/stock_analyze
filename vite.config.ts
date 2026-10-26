import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** 本地浏览器仅访问同源代理，账户凭证始终留在 CLI 中。 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787', '/chart-lab': 'http://127.0.0.1:8787' } },
  preview: { host: '127.0.0.1' },
});
