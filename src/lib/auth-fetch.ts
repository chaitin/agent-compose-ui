import { requireLogin } from './auth';

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    requireLogin();
  }
  return response;
}
