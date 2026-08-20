import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The API backend, which had no test file at all.
 *
 * Its last bug was a silent drop: documents were filtered by a `.pdf` filename suffix, while
 * the caller selects a document by MIME type and the stored name carries no extension when
 * the upload had none — so a real PDF named `resume` was discarded here and the model was
 * asked to extract a file it never saw. That is the exact failure the backend seam exists to
 * end, and it happened on this path only, so the CLI path's tests could not have caught it.
 *
 * The SDK is mocked because the alternative is a live billed request. What is under test is
 * everything this file decides before the request goes out: which model, what is attached,
 * which tools are granted, and how a failure is classified.
 */

const h = vi.hoisted(() => ({
  sent: [] as Array<Record<string, unknown>>,
  reply: {
    content: [{ type: 'text', text: 'answered' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Record<string, unknown>,
  hasKey: true,
}));

vi.mock('../src/infra/llm/client', async (importOriginal) => {
  const real = await importOriginal<object>();
  return {
    ...real,
    hasApiKey: () => h.hasKey,
    getClient: () => ({
      messages: {
        create: (body: Record<string, unknown>) => {
          h.sent.push(body);
          return Promise.resolve(h.reply);
        },
      },
    }),
  };
});

const { apiBackend } = await import('../src/infra/llm/apiBackend');
const { NoModelAccessError } = await import('../src/infra/llm/provider');
const { runMigrations } = await import('../src/infra/db/migrate');

let dir: string;

beforeAll(() => {
  // A generated answer is written to the llm_call ledger, so the tables have to exist.
  runMigrations();
});

beforeEach(() => {
  h.sent = [];
  h.hasKey = true;
  dir = mkdtempSync(path.join(tmpdir(), 'ia-apibackend-'));
});

/** A file with no extension at all — the shape that used to be dropped. */
function storedPdf(name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.from('%PDF-1.4 fake'), { mode: 0o600 });
  return file;
}

describe('attaching a document', () => {
  it('attaches a PDF whose stored name has no extension', () => {
    // The regression: the upload route names the stored file by ULID, so a resume uploaded
    // without an extension has none. Filtering on `.pdf` dropped it silently.
    return apiBackend
      .generate({
        purpose: 'resume_extraction',
        system: 's',
        user: 'u',
        documents: [storedPdf('01JABCDEF')],
      })
      .then(() => {
        const content = (h.sent[0]?.['messages'] as Array<{ content: unknown }>)[0]?.content;
        expect(Array.isArray(content)).toBe(true);
        const blocks = content as Array<{ type: string }>;
        expect(blocks.filter((b) => b.type === 'document')).toHaveLength(1);
      });
  });

  it('sends the prompt as plain text when there is nothing to attach', () => {
    return apiBackend
      .generate({ purpose: 'answer_draft', system: 's', user: 'the prompt' })
      .then(() => {
        const content = (h.sent[0]?.['messages'] as Array<{ content: unknown }>)[0]?.content;
        expect(content).toBe('the prompt');
      });
  });

  it('puts the text after the documents, so the model reads the file first', () => {
    return apiBackend
      .generate({
        purpose: 'resume_extraction',
        system: 's',
        user: 'u',
        documents: [storedPdf('a')],
      })
      .then(() => {
        const blocks = (h.sent[0]?.['messages'] as Array<{ content: Array<{ type: string }> }>)[0]
          ?.content;
        expect(blocks?.[blocks.length - 1]?.type).toBe('text');
      });
  });
});

describe('what the request asks for', () => {
  it('grants web search only when the caller asked for it', () => {
    return apiBackend
      .generate({ purpose: 'web_discovery', system: 's', user: 'u', webSearch: true })
      .then(() => {
        const tools = h.sent[0]?.['tools'] as Array<{ type: string }> | undefined;
        expect(tools?.[0]?.type).toBe('web_search_20250305');
      });
  });

  it('grants nothing on an ordinary draft', () => {
    // The property the default protects, and the one no test held.
    return apiBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }).then(() => {
      expect(h.sent[0]?.['tools']).toBeUndefined();
    });
  });

  it('sends the cheap model for discovery and the extraction model for a resume', () => {
    // Discovery is judgment-light by design: the model names candidate URLs and this process
    // fetches and parses every one of them.
    return apiBackend
      .generate({ purpose: 'web_discovery', system: 's', user: 'u' })
      .then(() => apiBackend.generate({ purpose: 'resume_extraction', system: 's', user: 'u' }))
      .then(() => {
        expect(h.sent[0]?.['model']).not.toBe(h.sent[1]?.['model']);
      });
  });
});

describe('when there is no key', () => {
  it('says so as a setup problem, not as something that broke', () => {
    // `isSetupProblem` decides between "go and configure something" and "something went
    // wrong", and the callers pick their wording from it.
    h.hasKey = false;
    return apiBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }).then(
      () => expect.unreachable('should have refused'),
      (err: unknown) => {
        expect(err).toBeInstanceOf(NoModelAccessError);
        expect((err as InstanceType<typeof NoModelAccessError>).reason).toBe('no_key');
        expect((err as InstanceType<typeof NoModelAccessError>).isSetupProblem).toBe(true);
      },
    );
  });

  it('does not send a request at all', () => {
    h.hasKey = false;
    return apiBackend
      .generate({ purpose: 'answer_draft', system: 's', user: 'u' })
      .catch(() => undefined)
      .then(() => {
        expect(h.sent).toHaveLength(0);
      });
  });
});
