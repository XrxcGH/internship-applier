import { HealthResponse } from '@ia/shared';

/**
 * The server requires X-App-Token on every route except /api/health. M1 wires the
 * token through from the served page; for now only health is reachable.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(path: string): Promise<unknown> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new ApiError(`${path} responded ${res.status}`, res.status);
  }
  return res.json();
}

export async function fetchHealth(): Promise<HealthResponse> {
  return HealthResponse.parse(await request('/api/health'));
}
