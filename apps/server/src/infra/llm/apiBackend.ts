/**
 * The Anthropic API as a model backend — the ANTHROPIC_API_KEY path.
 *
 * Wraps the existing SDK client in the same `Backend` interface the CLI uses, so nothing
 * upstream has to know which one it is talking to.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { getClient, hasApiKey, MODELS, recordCall } from './client';
import {
  NoModelAccessError,
  type Backend,
  type GenerateRequest,
  type GenerateResult,
} from './provider';

/**
 * The user turn, with any requested documents attached.
 *
 * `documents` names files on disk because that is the only form the CLI backend can use —
 * it has no way to accept bytes, so it is granted Read on the file and opens it itself.
 * This path has the opposite constraint: the API takes a base64 block and cannot read a
 * path. Both halves have to exist for the seam to mean anything, and while this one did
 * not, a request carrying a PDF reached the API with the field silently dropped and the
 * model was asked to extract a resume it had never been shown.
 *
 * Every path in `req.documents` is a PDF by the seam's contract (see provider.ts) — only
 * PDFs are attached; everything else is extracted to text upstream. So ATTACH THEM ALL,
 * matching the CLI backend, which passes every path through by name. The earlier version
 * filtered by a `.pdf` filename suffix instead, but the caller selects a document by its
 * MIME type and the stored name carries no extension when the upload had none — so a real
 * PDF named `resume` was silently dropped here and the model was asked to extract a file
 * it never saw, exactly the failure this seam existed to end, and only on the API path.
 */
async function userContent(req: GenerateRequest): Promise<string | ContentBlock[]> {
  const documents = req.documents ?? [];
  if (documents.length === 0) return req.user;

  const blocks: ContentBlock[] = [];
  for (const file of documents) {
    blocks.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: (await readFile(file)).toString('base64'),
      },
    });
  }
  blocks.push({ type: 'text', text: req.user });
  return blocks;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: 'application/pdf'; data: string };
    };

/** Purposes map to model tiers per docs/02. */
function modelFor(purpose: GenerateRequest['purpose']): string {
  switch (purpose) {
    case 'resume_extraction':
    case 'requirement_extraction':
      return MODELS.extraction;
    // Web discovery is judgment-light on purpose: the model's only job is to run searches
    // and hand back candidate URLs, and every page it names is then fetched and parsed by
    // this process's own deterministic readers. A bad candidate costs one wasted fetch,
    // which the run report counts out loud — not a wrong fact in the queue. The cheap
    // model does that fine, and a discovery run may make this call often.
    case 'web_discovery':
    case 'field_classification':
      return MODELS.classification;
    case 'fact_guard':
    case 'style_critic':
      return MODELS.verification;
    default:
      return MODELS.drafting;
  }
}

export const apiBackend: Backend = {
  kind: 'api',

  available(): Promise<boolean> {
    return Promise.resolve(hasApiKey());
  },

  describe(): string {
    return hasApiKey() ? 'Anthropic API key (billed per token)' : 'Anthropic API key (not set)';
  },

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!hasApiKey()) {
      throw new NoModelAccessError('No ANTHROPIC_API_KEY is configured.');
    }

    const model = modelFor(req.purpose);
    const started = Date.now();

    const response = await getClient().messages.create({
      model,
      max_tokens: req.maxTokens ?? 4000,
      system: req.system,
      thinking: { type: 'adaptive' },
      ...(req.schema
        ? {
            output_config: {
              // Resume extraction runs at 'high': it is a one-shot read of a whole document
              // where a missed section is a lost job, and it ran at 'high' before extraction
              // moved onto this seam. The move hardcoded 'medium' for every schema request,
              // silently downgrading it. Bulk, cheaper purposes stay at 'medium'.
              effort: req.purpose === 'resume_extraction' ? ('high' as const) : ('medium' as const),
              format: {
                type: 'json_schema' as const,
                schema: req.schema.jsonSchema,
              },
            },
          }
        : {}),
      // The server-side web-search tool: Anthropic's own infrastructure runs the searches,
      // so nothing here scrapes a search engine and no extra key is involved. Capped so a
      // single discovery call cannot run away with the bill — each use is billed.
      ...(req.webSearch
        ? {
            tools: [
              { type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 8 },
            ],
          }
        : {}),
      messages: [{ role: 'user' as const, content: await userContent(req) }],
    });

    recordCall({
      purpose: req.purpose,
      model,
      usage: response.usage as never,
      latencyMs: Date.now() - started,
      stopReason: response.stop_reason,
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    let structured: unknown;
    if (req.schema && text) {
      try {
        structured = JSON.parse(text);
      } catch {
        structured = undefined;
      }
    }

    return { text, structured, stopReason: response.stop_reason, provider: 'api' };
  },
};

/** Convenience for callers that already hold a Zod schema. */
export function jsonSchemaOf(name: string, schema: z.ZodType): GenerateRequest['schema'] {
  return {
    name,
    jsonSchema: z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>,
  };
}
