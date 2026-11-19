import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 10001,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:10002',
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'mui-vendor', test: /node_modules\/@mui|node_modules\/@emotion/, priority: 10 },
          ],
        },
      },
    },
  },
})
