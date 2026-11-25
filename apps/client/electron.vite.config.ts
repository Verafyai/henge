import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      // Workspace packages ship TypeScript source, so they are bundled; npm deps stay external.
      externalizeDeps: { exclude: ['@swarm-explorer/api-client', '@swarm-explorer/core', '@swarm-explorer/node-core', '@swarm-explorer/sandbox', '@swarm-explorer/schema'] },
      // The supervisor and the model proxy are separate utility processes (SPEC 11.2) with their own entries.
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts'), supervisor: resolve(__dirname, 'src/supervisor/index.ts'), proxy: resolve(__dirname, 'src/proxy/index.ts') },
      },
    },
  },
  preload: {
    // Sandboxed preloads must be a single CommonJS file that only requires `electron`.
    build: {
      externalizeDeps: false,
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts'), output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
