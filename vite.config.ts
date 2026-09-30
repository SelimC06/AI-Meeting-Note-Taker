import { defineConfig } from 'vitest/config'
import { resolve } from "path";
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'


import { cloudflare } from "@cloudflare/vite-plugin";
import { CONTENT_SECURITY_POLICY } from "./src/ui/csp";

// Adds the CSP meta tag to both pages in production builds only (see
// src/ui/csp.ts for why not in dev).
const contentSecurityPolicy = {
  name: "deskrecap-csp",
  apply: "build" as const,
  transformIndexHtml(html: string) {
    return html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`
    );
  },
};


// https://vite.dev/config/
export default defineConfig({
  plugins: [react({
    babel: {
      plugins: [['babel-plugin-react-compiler']],
    },
  }), tailwindcss(), cloudflare(), contentSecurityPolicy],
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