/**
 * Thin client for the conversation API.
 * The backend owns history; this module is the only place that knows the URLs.
 */

const parse = async (response) => {
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(data?.error || `Conversation API failed (${response.status})`)
  }
  return data
}

const request = (url, options) => fetch(url, {
  ...options,
  headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
}).then(parse)

export const chatApi = {
  list: () => request('/api/chats'),
  get: (id) => request(`/api/chats/${encodeURIComponent(id)}`),
  create: (title) => request('/api/chats', { method: 'POST', body: JSON.stringify({ title }) }),
  update: (id, patch) => request(`/api/chats/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  }),
  remove: (id) => request(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clear: (id) => request(`/api/chats/${encodeURIComponent(id)}/clear`, { method: 'POST' }),
}
