# 13 — Dependency audit notes

Standing assessments for `npm audit` findings that are **not** going to be "fixed", so
nobody has to re-derive the reasoning every time the warning scrolls past.

The rule: every accepted finding needs evidence that it is unreachable or inapplicable,
not just an assertion that it feels minor. If that evidence can't be produced, fix it.

---

## esbuild ≤0.24.2 via drizzle-kit — accepted, 2026-08-03

**What npm reports.** 4 moderate findings, all the same root:

```
drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils → esbuild@0.18.20
```

[GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99): esbuild's
development server sets a permissive CORS header, so any website the developer visits can
issue requests to it and read the responses.

**Why it does not apply here.**

1. **The vulnerable code is never loaded.** `@esbuild-kit` appears in exactly one file
   under `node_modules/drizzle-kit/` — its own `package.json`. It is a declared dependency
   that the shipped code never imports. Verified by hooking `Module._load` across a full
   `npm run db:generate`: the loader is not pulled in. drizzle-kit actually uses `tsx`
   (the successor to esbuild-kit, same author), which it also declares, alongside a
   current `esbuild@^0.25.4`.
2. **The vulnerability is in a feature nothing here invokes.** It concerns `esbuild serve`.
   drizzle-kit transpiles a schema file; it never starts an esbuild dev server.
3. **It is a devDependency.** `drizzle-kit` runs only for `npm run db:generate`. Nothing
   from this tree reaches the running application or the user's machine at runtime.

**Why not just run the suggested fix.** `npm audit fix --force` resolves this by
installing **drizzle-kit@0.18.1** — a downgrade of thirteen minor versions from 0.31.10.
That would break migration generation against the current schema. Trading a working
migration tool for an unreachable advisory is a bad trade.

**Why there is no `overrides` entry.** One was tried and removed. npm declines to apply an
override to `@esbuild-kit/core-utils`'s pinned `~0.18.20` at any nesting depth
(`{"@esbuild-kit/core-utils": …}`, and the full `drizzle-kit → esm-loader → core-utils`
path). Leaving a config block that silently does nothing is worse than none, so it went.

**When to revisit.** drizzle-kit 0.31.10 is the latest release as of this note and still
declares the dependency. If a later version drops `@esbuild-kit/esm-loader`, upgrading
clears all four findings for free — check on the next dependency bump.

---

## CI policy

`npm audit --audit-level=high` gates the build. Moderate findings are reported but do not
fail it, because the only current moderate is the one documented above. If a moderate
finding appears that is **not** listed in this file, treat it as unreviewed and either fix
it or add an entry here with evidence.
