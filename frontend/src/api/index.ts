// The app's backend client, pointed at VITE_API_URL (default http://127.0.0.1:8787).
import { API_URL } from '../config'
import { createApiClient } from './client'

export const api = createApiClient({ baseUrl: API_URL })

export { ApiError, createApiClient, isApiError, type ApiClient } from './client'
export type * from './types'
export { EVENT_TYPES, STATUSES, WARNINGS } from './types'
