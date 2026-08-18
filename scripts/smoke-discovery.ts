/**
 * Points the real discovery adapters at the real internet and reports what came back.
 *
 * Every other check in this repo runs against a fixture. This one answers the question a
 * fixture cannot: whether the endpoints these adapters were written against are still there,
 * still shaped the way `normalize.ts` expects, and still returning postings a student could
 * actually apply to. It found nothing that `npm test` would have found — that is the point.
 *
 * It writes nothing. No database, no `source` rows, no `job_posting` rows: the adapters are
 * called directly, their results counted, and everything dropped. Run it with
 * `npx tsx scripts/smoke-discovery.ts`, and expect it to take a minute — the fetcher is rate
 * limited on purpose.
 *
 * Keyed sources report themselves unconfigured when there is no key, which is a pass: the
 * point of the check is that the adapter says so out loud rather than contributing nothing in
 * silence.
 */
import { ALL_SOURCES } from '../apps/server/src/core/discovery/run';
import { resolveCompany } from '../apps/server/src/core/discovery/resolveCompany';
import type { NormalizedPosting } from '../apps/server/src/core/discovery/sources/types';

/** Boards picked because they are large, public, and have run internship programs for years. */
const TARGETS: Array<{ source: string; board: string }> = [
  { source: 'greenhouse', board: 'stripe' },
  { source: 'greenhouse', board: 'databricks' },
  { source: 'lever', board: 'palantir' },
  { source: 'ashby', board: 'ramp' },
  { source: 'github_list', board: '' },
  { source: 'adzuna', board: '' },
  { source: 'usajobs', board: '' },
];

const INTERNISH = /\b(intern|internship|co-?op|new grad|university|student|apprentice)\b/i;

function summarize(postings: NormalizedPosting[]): string {
  const interns = postings.filter((p) => INTERNISH.test(p.title));
  const dated = postings.filter((p) => p.term.year !== null).length;
  const paid = postings.filter((p) => p.compensation !== null).length;
  const located = postings.filter((p) => p.locations.length > 0).length;
  return (
    `${postings.length} postings · ${interns.length} look student-facing · ` +
    `${located} with a location · ${dated} with a term year · ${paid} with pay`
  );
}

async function main(): Promise<void> {
  let reachable = 0;
  let unreachable = 0;

  for (const target of TARGETS) {
    const adapter = ALL_SOURCES[target.source];
    const name = `${target.source}${target.board ? `/${target.board}` : ''}`;
    if (!adapter) {
      console.log(`✗ ${name}: no such adapter`);
      unreachable++;
      continue;
    }

    if (adapter.requiresKey && !adapter.isConfigured()) {
      const result = await adapter.fetch({ board: target.board });
      console.log(`— ${name}: no key on this machine`);
      for (const note of result.notes) console.log(`    ${note}`);
      continue;
    }

    try {
      const result = await adapter.fetch({
        board: target.board,
        keywords: ['software engineering intern'],
        location: 'San Francisco',
      });
      console.log(`✓ ${name}: ${summarize(result.postings)}`);
      const first = result.postings.find((p) => INTERNISH.test(p.title));
      if (first) console.log(`    e.g. "${first.title}" — ${first.applyUrl}`);
      for (const note of [...result.notes, ...(result.gaps ?? [])]) console.log(`    ${note}`);
      reachable++;
    } catch (err) {
      console.log(`✗ ${name}: ${(err as Error).message}`);
      unreachable++;
    }
  }

  console.log('');
  // `resolveCompany` returns `{ matches, notes }`: the notes carry the vendors that could
  // not be checked at all, which an empty `matches` would otherwise report as "no board
  // anywhere". Reading the result as a bare array left this line printing a failure for
  // every company, on a script whose whole job is to say whether the real internet still
  // answers the way the adapters expect.
  const resolved = await resolveCompany('Figma');
  console.log(
    resolved.matches.length > 0
      ? `✓ company resolution: Figma → ${resolved.matches
          .map(
            (r) =>
              `${r.source}/${r.board} (${String(r.jobCount)} open` +
              `${r.fromFullName ? '' : ', first word only'})`,
          )
          .join(', ')}`
      : '✗ company resolution: nothing answered for Figma',
  );
  for (const note of resolved.notes) console.log(`  note: ${note}`);

  console.log('');
  console.log(`${reachable} sources reachable, ${unreachable} not`);
  if (unreachable > 0) process.exitCode = 1;
}

await main();
