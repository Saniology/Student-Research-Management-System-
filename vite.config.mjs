import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const port = Number(process.env.PORT || process.env.VITE_PORT || 5500);

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port, strictPort: false },
});
