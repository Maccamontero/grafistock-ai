import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    port: 3000,
    host: true,              // escucha en 0.0.0.0 (necesario en Codespaces/contenedores)
    allowedHosts: true,      // permite el dominio reenviado de Codespaces (*.app.github.dev)
    proxy: {
      '/api': 'http://localhost:3001',
    },
    hmr: process.env.DISABLE_HMR !== 'true',
  },
}));
