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
 * Only PDFs are sent as documents. Everything else is extracted to text before it gets
 * here, and a format the API would reject is better refused than sent.
 */
async function userContent(req: GenerateRequest): Promise<string | ContentBlock[]> {
  const pdfs = (req.documents ?? []).filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (pdfs.length === 0) return req.user;

  const blocks: ContentBlock[] = [];
  for (const file of pdfs) {
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
              effort: 'medium' as const,
              format: {
                type: 'json_schema' as const,
                schema: req.schema.jsonSchema,
              },
            },
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
