import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite dev-server config.
//
// host:true            — bind 0.0.0.0 so the dev server is reachable from
//                        ngrok / Tailscale / a phone on the same Wi-Fi.
// allowedHosts         — Vite blocks unknown Host headers by default; opt in
//                        common HTTPS tunnel domains so requests from
//                        `https://<x>.ngrok-free.app` aren't rejected.
// proxy                — forwards backend API calls to uvicorn on :8000 so
//                        the same origin (and the same ngrok tunnel) serves
//                        both the frontend and the API. The frontend uses
//                        relative URLs (`/identify`, `/lyrics`, `/fallback`,
//                        `/health`) so no CORS, no `VITE_API_BASE`, no
//                        second tunnel needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    allowedHosts: [
      ".ngrok-free.dev",
      ".ngrok-free.app",
      ".ngrok.io",
      ".ngrok.app",
      ".trycloudflare.com",
      ".ts.net",
    ],
    proxy: {
      "/identify": "http://localhost:8000",
      "/lyrics": "http://localhost:8000",
      "/fallback": "http://localhost:8000",
      "/health": "http://localhost:8000",
    },
  },
});
