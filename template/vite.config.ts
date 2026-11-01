import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Vite runs in the app's pod, whose port is published on 127.0.0.1 only, so it is
    // reachable only through apps-builder's preview dispatcher, which sits behind
    // Traefik forwardAuth. Without this, Vite rejects
    // every request with "Blocked request. This host is not allowed." — the Host
    // header arriving here is <slug>.preview.<domain>, never localhost.
    allowedHosts: true,
  },
})
