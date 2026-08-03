import { CandidateProfile, HealthResponse } from '@ia/shared';
import { appToken, clearToken } from './session';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      'x-app-token': await appToken(),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) clearToken();

  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    const e = body as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      e?.error?.message ?? `${path} responded ${res.status}`,
      res.status,
      e?.error?.code,
      e?.error?.details,
    );
  }
  return body as T;
}

export const fetchHealth = () => request<HealthResponse>('/api/health').then(HealthResponse.parse);

export interface ResumeDoc {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  isPrimary: boolean;
  createdAt: string;
}

export const listResumes = () => request<ResumeDoc[]>('/api/resumes');

export async function uploadResume(file: File): Promise<{ documentId: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/resumes', {
    method: 'POST',
    body: form,
    headers: { 'x-app-token': await appToken() },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body as { error?: { message?: string } } | null;
    throw new ApiError(e?.error?.message ?? `Upload failed (${res.status})`, res.status);
  }
  return body as { documentId: string };
}

export const extractResume = (id: string) =>
  request<{ profile: unknown; needsReview: string[] }>(`/api/resumes/${id}/extract`, {
    method: 'POST',
  }).then((r) => ({ profile: CandidateProfile.parse(r.profile), needsReview: r.needsReview }));

export const getProfile = () =>
  request<unknown>('/api/profile')
    .then(CandidateProfile.parse)
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });

export const saveProfile = (p: CandidateProfile) =>
  request<unknown>('/api/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  }).then(CandidateProfile.parse);

export const confirmProfile = () =>
  request<unknown>('/api/profile/confirm', { method: 'POST' }).then(CandidateProfile.parse);

export const clearReviewFlag = (path: string) =>
  request<unknown>(`/api/profile/reviewed/${encodeURIComponent(path)}`, { method: 'POST' }).then(
    CandidateProfile.parse,
  );
