# 08 — Frontend

React 19 + TypeScript + Vite + Tailwind 4. Nothing else. Runs at `http://127.0.0.1:5173` in
development, proxying `/api` to the Fastify server; in production the server builds and
serves the bundle from its own origin.

**This document was rewritten against the interface that exists.** It previously described
five libraries the app does not depend on, a router it does not have, seven screens under
paths that were never routes, and a component inventory matching none of the five real
components. What follows was read out of `apps/web/src`.

| Planned | Actual |
| --- | --- |
| shadcn/ui + Radix | Plain HTML controls in `components/Controls.tsx` |
| TanStack Query | `fetch` in `lib/api.ts`, one `refresh()` per screen |
| Zustand | One `useState<View>` in `App.tsx` |
| React Hook Form | Controlled inputs and a `patch()` helper |
| `@tanstack/react-virtual` | An ordinary list — the queue is hundreds, not thousands |

None of these was a mistake to plan or a mistake to drop. They were sized for an app with
routing, caching and a component library's worth of surface; this one has eight views and
six components, and each dependency would have been more machinery than the thing it
manages.

## Design stance

The UI's job is to make the human gates feel like the point of the product rather than speed
bumps. Concretely:

- **The review queue is keyboard-first.** Triaging forty postings should feel like triaging
  email. `J`/`K` to move, `A` to approve, `S` to skip, `X` to reject, `L` to save.
- **Evidence is always visible, not one click away.** Every filter decision shows the
  verbatim job-description quote that caused it; every generated claim shows the profile
  fact behind it, beside the text rather than behind a disclosure.
- **Nothing destructive or outbound happens without a deliberate action.** There is no
  bulk-approve, and the delete-everything control will not arm until the server has told the
  user exactly what would be destroyed.
- **The interface says what it does not know.** A rate computed from five applications is
  refused with a reason rather than shown as a percentage.

## Navigation

No router. `App.tsx` holds `const [view, setView] = useState<View>('home')`, and

```ts
type View =
  | 'home'
  | 'setup'
  | 'discovery'
  | 'queue'
  | 'applications'
  | 'tracker'
  | 'voice'
  | 'settings';
```

Eight views, no URLs, no deep links, no browser history. For a single-user local tool with
no sharing and no bookmarks this is enough; it is worth knowing that a refresh returns you
to the overview.

## Screens

### Overview — `home`

Server status, runtime, uptime, table count and whether a profile exists; the four gates
stated plainly; the milestone list. The entry point into G1 when no profile is established.

### Onboarding — `setup` (App.tsx renders `pages/Onboarding.tsx`)

Where **G1** lives. Three steps in one component, not a resumable wizard.

| Step | Contents |
| --- | --- |
| **1 · Resume** | Drag-drop or click to choose. PDF, DOCX, TXT, Markdown — legacy `.doc` is not accepted, because it cannot be read. |
| **2 · What the reader found** | Everything the extractor produced, all of it editable: name, pronouns, email and phone; then education, experience, projects, skills, certifications, languages and links, each an add/edit/reorder/remove list. Entry counts carry the number of lines under them, because "27 entries" hid an extraction that had kept every title and dropped every bullet. |
| **3 · What a resume never says** | Date of birth, work authorization, availability window, home city and state. Each says why it is asked. A flag clears only when the field actually holds an answer — reverting a control to its unanswered state puts the flag back. |

Confirmation is blocked while anything is flagged, and every flag has a control that can
clear it, including ones the wizard has no dedicated field for.

### Discover — `discovery` (`pages/Discovery.tsx`)

Where postings come from, and the screen M2 shipped without — for the whole of that milestone
the endpoints were reachable only over HTTP, the queue's empty state told people to POST to
`/api/discovery/run` by hand, and the query planner wrote notes saying "Resolve it in Discover"
about a screen that did not exist.

Six sections: what is stored and which sources have their key; the plan read out of the
profile, with its keywords, term tokens and target chips; a company box that either re-plans
with the names pinned or probes Greenhouse, Lever and Ashby for the board each one really
uses; the editable run list and its summary; the paste-a-URL path; and the earlier runs.

The run summary leads with an accounting that adds up — fetched, new, already stored, merged —
and puts the `skipped` list in its own notice under the heading "This search was not complete."
Nothing here runs on a schedule and nothing reaches the network until a button is pressed.

### Queue — `queue` (`pages/Matches.tsx`)

Where **G2** lives. Split view: list left, detail right.

- List rows: company, title, location, score, eligibility badge. Filtered-out postings sit
  in their own band rather than disappearing.
- Detail: the requirement checklist with verbatim quotes, the score breakdown, the
  rationale — including the honest reason you might be passed over — and the actions.
- Approving creates an application. It does not open a browser, draft anything, or submit.

### Applications — `applications` (`pages/Applications.tsx`)

Where **G3** lives. A list, then a per-application detail with the questions and their
answers. Each answer renders through `AnswerReview`:

- the question, the archetype, the word count and whether the answer was reused;
- the text with claim highlighting inline, green through red by FactGuard verdict;
- the blocking claims with the reason for each one;
- machine-sounding phrasing and style drift, as separate advisories;
- an edit meter, because approving something you have not changed is worth a second look;
- Approve, disabled while a blocking flag is unresolved.

Below that, `FillReview` shows the fill run: what was filled, what read back differently,
what was skipped and why, and the instruction to submit in the browser yourself.

### Tracker — `tracker` (`pages/Tracker.tsx`)

The board by status, the table, the reminders, the statistics and CSV export. Reply-time and
response-rate figures are withheld below ten observations with a sentence saying why.
Follow-ups and withdrawals are **drafted** for the user to send; nothing here sends email.

### Voice — `voice` (`pages/Voice.tsx`)

Writing samples in, measured style profile out, described in plain language.

### Settings — `settings` (`pages/Settings.tsx`)

Four sections: model access with a connection test, what it has cost, export everything, and
delete everything. **Not built:** API-key entry — Discover reports which sources have a key
and names the `.env` variables, but nothing in the interface writes one — the scoring-weight
editor with learned adjustments, and the answer-library editor that this doc used to list.

## Component inventory

Six, all in `components/`:

| Component | What it is |
| --- | --- |
| `Chrome` | `Nav`, `Page`, `RunningHead`, `Section`, `Field` — the frame every screen sits in |
| `ProfileEditors` | The G1 editors for experience, projects, skills, certifications, languages and links, plus the `ListEditor` the education rows share |
| `Controls` | `Button`, `TextField`, `TextArea`, `SelectField`, `Notice`, `Badge`, `Empty` |
| `AnswerReview` | One answer at gate G3, with its evidence and flags |
| `FillReview` | One fill run, and gate G4 |
| `RequirementChecklist` | Requirements with their quotes — the trust surface of the queue |

## State

Server state is fetched per screen with `fetch`, wrapped in `lib/api.ts` for the error
envelope and the `X-App-Token` header, and refreshed by an explicit `refresh()` after every
mutation. There is no cache and no invalidation graph.

`lib/session.ts` bootstraps the token from `GET /api/session` once and clears it on any 401,
so a server restart heals on the next request rather than requiring a reload.

Client state is `useState` inside the screen that owns it. The only genuinely global piece is
which view is open.

## Real-time — NOT WIRED UP

The server publishes SSE events and serves them at `GET /api/events`. The frontend does not
listen: a search for `EventSource` across `apps/web/src` finds nothing. Long operations
therefore report their progress in the response when they finish, not while they run. The
reconnect-and-invalidate design this section used to describe is unbuilt on the client side.

## Accessibility and polish

- Every interactive element is a real button, input, or select, reachable and operable by
  keyboard, with visible focus rings.
- Colour is never the only signal: flags carry text labels alongside the red, amber, green.
- Light and dark both ship, driven by CSS variables and the OS preference. Contrast was
  measured rather than assumed — see docs/12.
- Long lists are not virtualized. A season's queue is hundreds of rows, and the complexity
  of virtualization is not yet earned.
