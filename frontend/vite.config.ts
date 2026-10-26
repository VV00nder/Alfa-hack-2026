import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// В dev-режиме API проксируется на backend (docker compose пробрасывает его на 8000)
// VITE_BASE — подкаталог публикации (GitHub Pages: /<repo>/), по умолчанию корень
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8000" } },
});
