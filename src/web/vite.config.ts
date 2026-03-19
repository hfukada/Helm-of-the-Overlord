import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/app/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/tasks": "http://127.0.0.1:7777",
      "/repos": "http://127.0.0.1:7777",
      "/tokens": "http://127.0.0.1:7777",
      "/health": "http://127.0.0.1:7777",
      "/knowledge": "http://127.0.0.1:7777",
      "/comments": "http://127.0.0.1:7777",
    },
  },
});
