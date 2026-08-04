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

// ─────────────────────────────────────────────────────── writing samples & voice

export interface SampleSummary {
  id: string;
  kind: string;
  wordCount: number;
  preview: string;
}

export interface SamplesResponse {
  samples: SampleSummary[];
  totalWords: number;
  adequacy: { level: 'none' | 'thin' | 'enough' | 'plenty'; message: string };
}

export const listSamples = () => request<SamplesResponse>('/api/writing-samples');

export const addSample = (content: string, kind = 'other') =>
  request<{ id: string }>('/api/writing-samples', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, kind }),
  });

export const deleteSample = (id: string) =>
  request<null>(`/api/writing-samples/${id}`, { method: 'DELETE' });

export interface StyleResponse {
  metrics: Record<string, unknown>;
  description: string[];
  computedAt?: string;
}

export const computeStyle = () =>
  request<StyleResponse>('/api/style-profile/compute', { method: 'POST' });

export const getStyle = () =>
  request<StyleResponse>('/api/style-profile').catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });

// ───────────────────────────────────────────────────── applications & answers

export interface ApplicationSummary {
  id: string;
  status: string;
  company: string;
  title: string;
  applyUrl: string;
  deadlineAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  answerCount: number;
  approvedCount: number;
  blockedCount: number;
}

export interface AnswerFlag {
  type: 'unsupported' | 'overstated' | 'style_drift' | 'ai_tell';
  span: { start: number; end: number };
  note: string;
}

export interface AnswerEvidence {
  claim: string;
  verdict: 'supported' | 'inferred' | 'unsupported' | 'overstated';
  profileRef: string | null;
  quote: string | null;
}

export interface Answer {
  id: string;
  applicationId: string;
  questionText: string;
  fieldKey: string;
  answerType: string;
  draftText: string;
  finalText: string;
  text: string;
  editDistance: number;
  editSummary: string;
  evidence: AnswerEvidence[];
  flags: AnswerFlag[];
  approvedAt: string | null;
  archetype: string;
  styleNote?: string | null;
  reusedFrom?: { useCount: number; company: string | null } | null;
  revised?: boolean;
  unresolved?: boolean;
}

export interface ApplicationDetail {
  id: string;
  company: string;
  title: string;
  description: string;
  answers: Answer[];
  canDraft: boolean;
}

export const listApplications = () =>
  request<{ applications: ApplicationSummary[] }>('/api/applications').then((r) => r.applications);

export const getApplication = (id: string) => request<ApplicationDetail>(`/api/applications/${id}`);

export const addQuestion = (applicationId: string, questionText: string) =>
  request<Answer>(`/api/applications/${applicationId}/questions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questionText }),
  });

export const deleteAnswer = (id: string) =>
  request<null>(`/api/answers/${id}`, { method: 'DELETE' });

export const draftAnswer = (id: string, maxWords?: number) =>
  request<Answer>(`/api/answers/${id}/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxWords }),
  });

export const saveAnswer = (id: string, text: string) =>
  request<Answer>(`/api/answers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });

/** Gate G3. Rejects with 409 UNVERIFIED_CLAIMS while any claim is unsupported. */
export const approveAnswer = (id: string) =>
  request<Answer>(`/api/answers/${id}/approve`, { method: 'POST' });

export const unapproveAnswer = (id: string) =>
  request<Answer>(`/api/answers/${id}/unapprove`, { method: 'POST' });
