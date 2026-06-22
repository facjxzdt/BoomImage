import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  optimizeDeps: {
    noDiscovery: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/media": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
});
