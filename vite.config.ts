import { defineConfig } from 'vitest/config'
import { resolve } from "path";
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'


import { cloudflare } from "@cloudflare/vite-plugin";


// https://vite.dev/config/
export default defineConfig({
  plugins: [react({
    babel: {
      plugins: [['babel-plugin-react-compiler']],
    },
  }), tailwindcss(), cloudflare()],
  base: "./",
  build: {
    outDir: 'dist-react',
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        rail: resolve(__dirname, "rail.html"),
      },
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/ui/test-setup.ts"],
    include: ["src/ui/**/*.test.{ts,tsx}", "src/rail/**/*.test.{ts,tsx}"],
  },
})