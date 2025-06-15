import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['@vibe/core']
  },
  resolve: {
    alias: {
      // Polyfills for Node.js globals in browser
      'global': 'globalThis',
    }
  },
  // Add polyfill for ReactDOM.findDOMNode compatibility
  esbuild: {
    define: {
      global: 'globalThis',
    },
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    }
  }
})