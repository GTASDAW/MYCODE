import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (/node_modules\/(react|react-dom|react-router)\//.test(id))
            return "react";
          if (/node_modules\/@rc-component\//.test(id)) return "components";
          if (/node_modules\/(antd|@ant-design)\//.test(id)) return "ui";
        },
      },
    },
  },
});
