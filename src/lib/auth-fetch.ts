import { requireLogin } from './auth';

let sessionIsAnonymous = false;

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    if (!sessionIsAnonymous) {
      sessionIsAnonymous = true;
      requireLogin();
    }
  } else {
    sessionIsAnonymous = false;
  }
  return response;
}
