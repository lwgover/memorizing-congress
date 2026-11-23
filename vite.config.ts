import { defineConfig } from "vite";

// GitHub Pages serves the site from /memorizing-congress/
export default defineConfig({
  base: "/memorizing-congress/",
  build: { target: "es2022", chunkSizeWarningLimit: 800 },
});
