# 14 — Model access

Where model calls go, and why the options are what they are.

Two things in this app need a model: reading a resume into a structured profile (M1) and
drafting an answer (M5). **Nothing else does.** Discovery, requirement extraction's regex
pass, the twelve eligibility rules, scoring, FactGuard's deterministic layer, StyleCritic,
and the tell-scrub are all pure functions running on this machine. An install with no model
access is a reduced tool, not a broken one, and `GET /api/model-access` says exactly which
parts are affected.

---

## The three backends

Selected by `LLM_PROVIDER` in `.env`. The default, `auto`, prefers the CLI, then an API
key, then nothing.

| Value | What it does |
| --- | --- |
| `auto` | CLI if installed, else API key, else no model. |
| `claude_cli` | Spawn the user's own `claude` binary. |
| `api` | `ANTHROPIC_API_KEY` against the Anthropic API. |
| `none` | Refuse model calls. Used by the test suite. |

---

## `claude_cli` — the subscription path

**The rule this is built around.** A Claude Pro/Max subscription is not an API key.
Anthropic's Agent SDK documentation states:

> Unless previously approved, Anthropic does not allow third party developers to offer
> claude.ai login or rate limits for their products, including agents built on the Claude
> Agent SDK.

and a February 2026 policy clarification extends that to *using OAuth tokens obtained
through Claude Free, Pro, or Max accounts in any other product, tool, or service*.
Enforcement began in January 2026.

**So this backend does not touch a token.** It runs Anthropic's own client as a
subprocess. The CLI authenticates itself, against its own stored credentials, and returns
text on stdout. There is no code path in `infra/llm/claudeCli.ts` that opens `~/.claude`,
and none that contacts `api.anthropic.com`. That is the distinction between "scripting the
client you are licensed to use" and "reusing its credentials elsewhere", and it is the
whole reason this design is shaped the way it is.

**The honest caveat.** Anthropic documents scripting `claude -p` in pipelines and CI, and
the Consumer Terms carve out automated access "where we otherwise explicitly permit it".
For a personal tool, run locally, by the person whose subscription it is, that reads as
permitted. **It stops reading that way if this app is distributed to other people who are
expected to sign in with their own subscriptions** — at that point it is a third-party
product offering claude.ai login, which is the thing named above. If this ever ships to
anyone else, that build must default to `api` and the CLI backend should be removed or
gated behind a clear notice.

### Verified against the real CLI (2.1.222)

Every flag below was checked by running the installed binary, not inferred from docs:
`--print`, `--output-format json`, `--system-prompt-file`, `--max-turns`,
`--allowedTools`, `--add-dir`, and `--json-schema` all exist and parse. The response
envelope carries `result`, `is_error`, `subtype`, `total_cost_usd`, `session_id`, and
`num_turns`, which is what the parser reads.

Two things measurement found that reading would not have:

- **An empty `--allowedTools ""` is broken when spawned.** It parses fine typed into a
  shell, but an empty argv element is dropped in transit and the CLI then rejects the
  flag as missing its argument, which would have failed every call. The allowlist now
  carries a name that matches no tool: it grants nothing and survives the trip.
- **The npm `claude.cmd` shim cannot be used.** Node needs `shell: true` to run a .cmd,
  which concatenates arguments rather than escaping them (Node’s DEP0190 warning), and
  a JSON schema argument arrives mangled and is rejected as invalid JSON. The adapter
  skips the shim and runs the `bin/claude.exe` inside the package that the shim itself
  calls, so there is no shell anywhere in this path.

### How it is invoked, and why

Three constraints shape the command, none of them obvious:

1. **`--bare` cannot be used.** It skips credential discovery and then requires an
   `ANTHROPIC_API_KEY` — exactly what we do not have. Tools, skills, and MCP are disabled
   with `--allowedTools ''` instead.

2. **Long text cannot go on the command line.** Windows caps a command line near 8191
   characters, and drafting prompts carry an evidence block plus writing samples. The
   system prompt is written to a temp file and passed with `--system-prompt-file`; the
   user content goes on **stdin**, which the CLI reads as input data.

3. **`--system-prompt-file` replaces rather than appends.** That is what we want. Claude
   Code's default prompt frames the model as a coding agent working in a repository, which
   is the wrong voice for a job application.

Reading a resume PDF is the one case that needs a tool: a document cannot be passed inline,
so that call adds `--allowedTools Read` and `--add-dir` for the directory holding the file
— that directory only, never the repository.

### The failure mode worth knowing about

If stdin were ever ignored, generation would not error. It would succeed and answer the
wrong question, which is worse than a crash. `POST /api/model-access/test` runs a real
round trip and checks the answer came back, so this is verifiable in one click rather than
discovered mid-draft.

### Usage limits

A subscription has rolling usage windows rather than per-token billing. When exhausted,
the CLI reports it in its output; the adapter matches on that and returns a message saying
the limit refills and that writing the answer by hand still gets it fact-checked. It does
not retry, and it does not queue.

---

## `api` — the API-key path

Unambiguous under the Commercial Terms, and the only option if this is ever distributed.
Billed per token, separately from any subscription.

Rough cost at Opus pricing for a realistic season: about **$0.02 per drafted answer** and
**$0.06 per resume read**. Forty applications at three questions each is roughly $3–6,
including the revision pass. Bulk requirement extraction across a large posting corpus is
the one expensive workload and should move to Haiku if it is ever run at scale.

---

## What is deliberately not supported

- **Reading the OAuth token out of `~/.claude`** and calling the API with it. This is the
  precise thing the policy prohibits, and it is why other tools were cut off in early 2026.
- **Extracting claude.ai session cookies**, or any proxy that impersonates the web client.
- **Bundling subscription credentials** so that other people's accounts power this app.

None of these are implemented, and none should be added.

---

## Testing

`vitest.setup.ts` pins `LLM_PROVIDER=none`. Without it, a developer with the CLI installed
would spend real subscription usage on every test run, and the suite would behave
differently from CI. No test may reach a model.
