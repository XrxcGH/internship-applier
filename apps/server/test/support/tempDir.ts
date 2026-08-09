/**
 * Removing a Chromium profile directory on Windows.
 *
 * `session.close()` returns before the OS has released every handle Chromium held under
 * its user-data directory, so an immediate recursive `rmSync` throws EPERM — and because
 * it throws from `afterAll`, vitest reports the whole suite as FAILED with every test in
 * it green. That is the worst possible shape for a flake: it says the browser tests broke
 * when nothing about them did, and the honest signal is buried under a teardown error.
 *
 * So: retry briefly, then give up quietly. The directory lives under the OS temp dir and
 * gets reaped there; a leftover copy is worth far less than a build that lies about which
 * tests passed. Never throws.
 */
import { rmSync } from 'node:fs';

export function removeTempDir(dir: string | undefined, attempts = 20): void {
  if (!dir) return;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // A busy-wait rather than a timer: this runs in afterAll, where an await would need
      // every caller to become async, and the wait is tens of milliseconds at worst.
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* wait for the handles to close */
      }
    }
  }
}
