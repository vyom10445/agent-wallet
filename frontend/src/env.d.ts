interface ImportMetaEnv {
  /** Backend base URL, default http://127.0.0.1:8787. The only setting the frontend reads. */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
