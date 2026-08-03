import type { SourceKind } from '@ia/shared';

/** A posting as it comes off a source, before eligibility or scoring. */
export interface NormalizedPosting {
  externalId: string | null;
  canonicalUrl: string;
  applyUrl: string;
  company: string;
  companyDomain: string | null;
  title: string;
  descriptionText: string;
  descriptionHtml: string | null;
  locations: Array<{ city?: string; region?: string; country?: string; remote: boolean }>;
  positionType: string | null;
  workArrangement: string | null;
  hybridDaysOnsite: number | null;
  remoteEligibleIn: string[];
  programFlags: string[];
  term: {
    season: string | null;
    year: number | null;
    start?: string;
    end?: string;
    durationWeeks: number | null;
    multiTerm: boolean;
  };
  compensation: Record<string, unknown> | null;
  requires: Record<string, boolean>;
  postedAt: string | null;
  closesAt: string | null;
  atsVendor: string;
}

export interface SourceQuery {
  /** Board slug / company token for ATS sources. */
  board?: string;
  keywords?: string[];
  location?: string;
  limit?: number;
}

export interface SourceResult {
  postings: NormalizedPosting[];
  /** Anything skipped or truncated is reported, never silently dropped (docs/04). */
  notes: string[];
}

export interface JobSource {
  kind: SourceKind;
  /** Whether this source needs an API key the user hasn't supplied. */
  requiresKey: boolean;
  isConfigured(): boolean;
  fetch(query: SourceQuery): Promise<SourceResult>;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
