import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds dist/report.html: one file, every script and style inlined, no external references.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    rollupOptions: { input: 'report.html' },
  },
});
