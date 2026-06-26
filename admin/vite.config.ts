import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// MiCall 运营管理端（内部）。后端就绪后，管理 API 走 VITE_API_BASE 配置
// （CLAUDE.md 铁律2，不硬编码）。当前为原型复刻，使用内置 mock 数据。
export default defineConfig({
  root: ".",
  plugins: [react()],
  server: { host: true, port: 5174 },
  build: { outDir: "dist", sourcemap: false },   // 内部后台亦不外泄源码（dev 仍有内联 sourcemap）
});
