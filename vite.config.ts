
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, (process as any).cwd(), '');

  return {
    base: './', // Crucial for Electron: allows assets to be loaded from relative paths
    plugins: [react()],
    define: {
      'process.env': JSON.stringify(env)
    }
  };
});
