/**
 * The Anthropic API as a model backend — the ANTHROPIC_API_KEY path.
 *
 * Wraps the existing SDK client in the same `Backend` interface the CLI uses, so nothing
 * upstream has to know which one it is talking to.
 */
import { z } from 'zod';
import { getClient, hasApiKey, MODELS, recordCall } from './client';
import {
  NoModelAccessError,
  type Backend,
  type GenerateRequest,
  type GenerateResult,
} from './provider';

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
      messages: [{ role: 'user' as const, content: req.user }],
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
