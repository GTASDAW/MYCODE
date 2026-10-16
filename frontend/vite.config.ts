import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { loadingEvidencePlugin } from "./loadingEvidencePlugin";

export default defineConfig({
  plugins: [react(), loadingEvidencePlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            const address = request.socket.remoteAddress;
            if (address) proxyRequest.setHeader("X-Gather-Client-IP", address);
            else proxyRequest.removeHeader("X-Gather-Client-IP");
          });
        },
      },
    },
  },
  build: { manifest: true },
});
