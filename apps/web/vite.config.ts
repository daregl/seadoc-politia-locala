import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:4100', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    // Fără URI-uri data: în CSS/JS: politica CSP este `default-src 'self'`.
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
