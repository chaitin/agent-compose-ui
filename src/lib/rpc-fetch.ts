import { authFetch } from './auth-fetch';

const RPC_TIMEOUT_MS = 120_000;

export function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(RPC_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return authFetch(input, { ...init, signal });
}
