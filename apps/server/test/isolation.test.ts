/**
 * The suite must not be able to touch the developer's real data.
 *
 * This exists because it already happened. `DATABASE_PATH` was isolated but the data
 * directory was not, so the privacy tests — which exercise a real `rm -rf` — deleted the
 * actual `data/resumes`, `data/artifacts`, and the master encryption key. The bug was
 * invisible: every test still passed.
 *
 * These assertions are cheap and they are the reason that cannot recur quietly.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, REPO_ROOT } from '../src/config';

const insideRepoData = (p: string): boolean => {
  const repoData = path.resolve(REPO_ROOT, 'data');
  const rel = path.relative(repoData, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

describe('the test suite writes nowhere near the real data directory', () => {
  it('puts every writable path under a temporary root', () => {
    for (const [name, p] of Object.entries({
      data: config.paths.data,
      resumes: config.paths.resumes,
      artifacts: config.paths.artifacts,
      browserProfile: config.paths.browserProfile,
      masterKey: config.paths.masterKey,
      database: config.paths.database,
    })) {
      expect(insideRepoData(p), `${name} resolves to ${p}`).toBe(false);
    }
  });

  it('derives every writable path from the same root', () => {
    // A path that does not descend from DATA_DIR is one the next isolation change misses.
    for (const p of [
      config.paths.resumes,
      config.paths.artifacts,
      config.paths.browserProfile,
      config.paths.masterKey,
    ]) {
      expect(path.relative(config.paths.data, p).startsWith('..'), p).toBe(false);
    }
  });

  it('is pinned to no model access, so no test can spend real usage', () => {
    expect(config.llm.provider).toBe('none');
  });
});
