// Same-origin API base, so LAN clients reach the host they loaded the page from.
export const API_BASE_URL =
  typeof window !== 'undefined' ? `${window.location.origin}/api` : '/api';
