import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(__dirname, "src/app/app.html"),
        settings: resolve(__dirname, "src/settings/settings.html"),
        background: resolve(__dirname, "src/background/background.ts"),
        content: resolve(__dirname, "src/content/content.ts"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "app") return "app.js";
          if (chunk.name === "settings") return "settings.js";
          return "[name].js";
        },
        chunkFileNames: "chunks/[name].js",
        assetFileNames: (asset) => {
          if (asset.name === "app.html") return "app.html";
          if (asset.name === "settings.html") return "settings.html";
          if (asset.name?.endsWith(".css")) return "app.css";
          return "assets/[name][extname]";
        },
      },
    },
  },
  plugins: [],
});
