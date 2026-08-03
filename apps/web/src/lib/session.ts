let tokenPromise: Promise<string> | null = null;

/**
 * The server issues a per-run token that every route except /api/health and /api/session
 * requires. Fetched once and cached; a 401 clears it so the next call re-bootstraps
 * (which is what happens after a server restart).
 */
export async function appToken(): Promise<string> {
  tokenPromise ??= fetch('/api/session')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('could not get a session token'))))
    .then((b: unknown) => (b as { token: string }).token)
    .catch((e: unknown) => {
      tokenPromise = null;
      throw e;
    });
  return tokenPromise;
}

export function clearToken(): void {
  tokenPromise = null;
}
