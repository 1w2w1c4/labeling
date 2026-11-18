import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開發時把 /api（後端）與 /demo-images（模擬模式的假圖片）轉給後端，前端和後端看起來是同一個網域
const backend = process.env.DL_BACKEND ?? 'http://127.0.0.1:8001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/demo-images': backend,
    },
  },
});
