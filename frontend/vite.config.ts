import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The app imports the address book and the ABIs straight from the P-1 folders, so they are never copied or edited here:
//   ../contracts/deployments/<chainId>.json   and   ../abi/*.json
// `vite build` bundles them without extra settings. The dev server only serves files inside its allow list, and that list
// is just frontend/ unless agent-wallet/ is a git repository, so both folders are listed explicitly. Nothing else outside
// frontend/ is allowed: in particular backend/ (its .env holds the agent and submitter keys) stays unreachable.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The backend's CORS allows exactly FRONTEND_ORIGIN (default http://localhost:5173). Another port or 127.0.0.1 is a
    // different origin and every API call fails, so never fall back to 5174 and always open http://localhost:5173.
    host: 'localhost',
    port: 5173,
    strictPort: true,
    fs: {
      allow: [here('.'), here('../abi'), here('../contracts/deployments')],
    },
  },
  // viem alone is close to 500 kB minified; this is a local app, so one chunk is fine and the warning is noise.
  build: { chunkSizeWarningLimit: 900 },
  preview: { host: 'localhost', port: 5173, strictPort: true },
})
