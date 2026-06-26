import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Production build for the MiCall user-facing H5.
// The realtime signaling endpoint is read from config (VITE_SIGNALING_URL),
// never hardcoded — see CLAUDE.md 铁律2 ("所有外部服务 endpoint/key 走配置").
export default defineConfig({
  root: ".",
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: "dist",
    sourcemap: false,   // 生产不外泄 TS 源码到浏览器 DevTools（dev 模式仍有内联 sourcemap，不影响调试）
  },
});
