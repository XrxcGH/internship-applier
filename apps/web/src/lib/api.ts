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

export interface ModelAccess {
  provider: 'api' | 'claude_cli' | 'none';
  available: boolean;
  description: string;
  limitations: string[];
}

export interface ApplicationDetail {
  id: string;
  company: string;
  title: string;
  description: string;
  applyUrl: string;
  answers: Answer[];
  canDraft: boolean;
  modelAccess: ModelAccess;
}

export const getModelAccess = () => request<ModelAccess>('/api/model-access');

export const testModelAccess = () =>
  request<ModelAccess & { tested: boolean; ok?: boolean; detail?: string }>(
    '/api/model-access/test',
    { method: 'POST' },
  );

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

// ───────────────────────────────────────────────────────────────── form filling

export interface FillFieldResult {
  label: string;
  semantic: string;
  redlineCategory: string | null;
  status: 'ok' | 'mismatch' | 'failed' | 'skipped';
  readBack: string | null;
  note: string | null;
}

export interface FillRunView {
  applicationId: string;
  state: 'opening' | 'reading' | 'awaiting_user' | 'filling' | 'done' | 'failed';
  url: string;
  message: string;
  startedAt: string;
  intervention: { reason: 'login' | 'captcha' | 'unknown_field'; detail: string } | null;
  summary: string | null;
  fields?: FillFieldResult[];
  counts: { filled: number; mismatched: number; failed: number; skipped: number } | null;
}

export const startFill = (id: string) =>
  request<FillRunView>(`/api/applications/${id}/fill`, { method: 'POST' });

export const continueFill = (id: string) =>
  request<FillRunView>(`/api/applications/${id}/fill/continue`, { method: 'POST' });

export const getFill = (id: string) =>
  request<FillRunView>(`/api/applications/${id}/fill`).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });

export const discardFill = (id: string) =>
  request<null>(`/api/applications/${id}/fill`, { method: 'DELETE' });

/** Gate G4. Records that YOU submitted it. Opens nothing, clicks nothing. */
export const markSubmitted = (id: string) =>
  request<{ id: string; status: string; submittedAt: string }>(
    `/api/applications/${id}/mark-submitted`,
    { method: 'POST' },
  );

// ─────────────────────────────────────────────────────────────────── tracker

export interface DerivedState {
  effectiveStatus: string;
  attention:
    | 'deadline_soon'
    | 'deadline_passed'
    | 'unfinished'
    | 'ready_to_fill'
    | 'awaiting_your_submit'
    | 'silent'
    | 'none';
  nudge: string | null;
  daysSinceSubmitted: number | null;
  daysUntilDeadline: number | null;
}

export interface TrackedApp {
  id: string;
  status: string;
  company: string;
  title: string;
  applyUrl: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  deadlineAt: string | null;
  answerCount: number;
  approvedCount: number;
  derived: DerivedState;
}

export interface Reminder {
  applicationId: string;
  kind: 'deadline' | 'follow_up' | 'still_open' | 'stale_offer';
  urgency: number;
  headline: string;
  detail: string;
}

export interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
  why?: string;
}

export interface TrackerStats {
  funnel: Record<string, number>;
  responseRate: Rate;
  interviewRate: Rate;
  medianDaysToResponse: number | null;
  bySource: Array<{
    key: string;
    submitted: number;
    responded: number;
    advanced: number;
    responseRate: Rate;
  }>;
  notes: string[];
}

export interface TrackerView {
  applications: TrackedApp[];
  reminders: Reminder[];
  stats: TrackerStats;
}

export const getTracker = () => request<TrackerView>('/api/tracker');

export const setStatus = (id: string, status: string) =>
  request<{ id: string; status: string }>(`/api/applications/${id}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });

export const getDraftMessage = (id: string, kind: 'follow_up' | 'withdrawal' = 'follow_up') =>
  request<{ kind: string; text: string; note: string }>(
    `/api/applications/${id}/draft-message?kind=${kind}`,
  );
