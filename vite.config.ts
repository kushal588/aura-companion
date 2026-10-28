import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Dev/preview hostnames are supplied by the environment, never hardcoded:
//   __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=example.host vite
const extraAllowedHosts = (process.env['__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS'] ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: false,
    allowedHosts: ['localhost', '127.0.0.1', ...extraAllowedHosts],
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
  },
  build: {
    target: 'es2022',
    // Source maps are for local debugging only; release artifacts are built without them.
    sourcemap: process.env['AURA_SOURCEMAP'] === '1',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.tsx', 'src/main.tsx'],
    },
  },
});
