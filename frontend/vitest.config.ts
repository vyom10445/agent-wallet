import { defineConfig } from 'vitest/config'

// Unit tests run in Node with a mocked fetch and a mocked RPC transport: no backend, browser or network needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
