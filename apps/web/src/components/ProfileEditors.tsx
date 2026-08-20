import type { ReactNode } from 'react';
import { ROLE_FAMILIES, ExperienceType } from '@ia/shared';
import type { CandidateProfile, ExperienceEntry, ProjectEntry, Skill } from '@ia/shared';
import { indexRange, moveListItem } from '../lib/profileEdit';
import { Button, SelectField, TextField } from './Controls';

/**
 * The G1 editors for everything the reader pulls out of a resume that is not a school.
 *
 * G1 is the gate where an extraction error is corrected, so anything the wizard cannot edit
 * is an extraction error made permanent. Until these existed the confirm screen showed three
 * counts — "Experience · 27 entries", "Projects · none found", "Skills · none found" — and a
 * note saying entries were not editable yet. That was not a cosmetic gap. A real resume came
 * back as twenty-seven bare titles with not one of the lines printed underneath them, and the
 * student could neither see that had happened nor put a single line back: the evidence corpus
 * every generated sentence is checked against was gone, and the only remedy on the screen was
 * to upload the file again and hope.
 *
 * The shape rules these controls have to respect, because the server answers a breach with
 * "Profile did not match the expected shape" naming no field: an experience entry needs a
 * title and an organization, a project needs a name, a skill needs a name, and a URL has to
 * be a URL. `savingProblems` in the wizard names each one before any save is attempted.
 */

const EXPERIENCE_LABELS: Record<ExperienceEntry['type'], string> = {
  job: 'Job',
  internship: 'Internship',
  volunteer: 'Volunteer',
  research: 'Research',
  club: 'Club or activity',
  freelance: 'Freelance',
};

/** The shared schema keeps this one inline, so it is named here rather than re-declared. */
type Certification = CandidateProfile['certifications'][number];

const SKILL_CATEGORIES: Array<[Skill['category'], string]> = [
  ['language', 'Language'],
  ['framework', 'Framework'],
  ['tool', 'Tool'],
  ['domain', 'Domain'],
  ['soft', 'Working style'],
];

/**
 * The frame every entry list shares: a heading that counts, a card per entry with the
 * reordering and removal controls, and one button that adds.
 *
 * Never sliced or capped, for the reason the education list carries the same note: a list
 * that quietly stops at some round number is an extraction error the user cannot see, let
 * alone correct, and twenty-seven activities is a real resume rather than a pathological one.
 */
function EntryList<T>({
  label,
  singular,
  hint,
  entries,
  onChange,
  blank,
  children,
}: {
  label: string;
  singular: string;
  hint?: ReactNode;
  entries: T[];
  /**
   * `moved` is `oldIndexForNew` — supplied whenever entries changed POSITION, so the review
   * flags for this list, which are addressed by index, can be rewritten to follow them.
   * Omitted for edits that leave every index where it was.
   */
  onChange: (next: T[], moved?: number[], clears?: string) => void;
  /** A fresh entry for "Add", in whatever shape the schema demands of a new row. */
  blank: () => T;
  /** `replace(next, clears)` — `clears` names the flag that particular field answers. */
  children: (entry: T, index: number, replace: (next: T, clears?: string) => void) => ReactNode;
}) {
  const order = indexRange(entries.length);
  return (
    <div className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h3 className="u-eyebrow">{label}</h3>
        <span className="u-data text-faint">
          {entries.length === 0
            ? 'none found'
            : `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`}
        </span>
      </div>
      {hint && <p className="text-faint u-prose mb-3 text-[0.9375rem] leading-snug">{hint}</p>}

      {entries.length > 0 && (
        <ul className="space-y-6">
          {entries.map((entry, index) => (
            <li key={index} className="u-card-flat px-5 py-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="u-data text-faint text-[0.8125rem]">
                  {singular} {index + 1}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    aria-label={`Move ${singular.toLowerCase()} ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() =>
                      onChange(
                        moveListItem(entries, index, index - 1),
                        moveListItem(order, index, index - 1),
                      )
                    }
                  >
                    Up
                  </Button>
                  <Button
                    size="sm"
                    aria-label={`Move ${singular.toLowerCase()} ${index + 1} down`}
                    disabled={index === entries.length - 1}
                    onClick={() =>
                      onChange(
                        moveListItem(entries, index, index + 1),
                        moveListItem(order, index, index + 1),
                      )
                    }
                  >
                    Down
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Remove ${singular.toLowerCase()} ${index + 1}`}
                    onClick={() =>
                      onChange(
                        entries.filter((_, k) => k !== index),
                        order.filter((k) => k !== index),
                      )
                    }
                  >
                    Remove
                  </Button>
                </span>
              </div>
              {children(entry, index, (next, clears) =>
                onChange(
                  entries.map((e, k) => (k === index ? next : e)),
                  undefined,
                  clears,
                ),
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        <Button size="sm" onClick={() => onChange([...entries, blank()])}>
          Add {singular.toLowerCase()}
        </Button>
      </div>
    </div>
  );
}

/**
 * A list of arbitrary length that can be added to, edited, reordered and cut down.
 *
 * Honors, coursework, bullets and per-entry skills are all unbounded. Each row wraps rather
 * than truncating, so a long award name pushes the buttons onto the next line instead of
 * clipping the name the student needs to be able to read before they can correct it.
 */
export function ListEditor({
  label,
  singular,
  hint,
  items,
  onChange,
}: {
  label: string;
  singular: string;
  hint?: string;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[1rem]">{label}</span>
        <span className="u-data text-faint text-[0.8125rem]">{items.length}</span>
      </div>
      {hint && <p className="text-faint u-prose mt-1 text-[0.9375rem] leading-snug">{hint}</p>}

      {items.length > 0 && (
        <ul className="mt-2 space-y-2">
          {items.map((item, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="u-data text-faint w-6 shrink-0 text-right">{i + 1}</span>
              <input
                value={item}
                aria-label={`${singular} ${i + 1}`}
                onChange={(e) => onChange(items.map((x, k) => (k === i ? e.target.value : x)))}
                className="u-data border-rule focus:border-accent min-w-[12rem] flex-1 rounded-t border-b bg-transparent px-1 py-1.5 outline-none transition-colors"
              />
              <span className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  aria-label={`Move ${singular.toLowerCase()} ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => onChange(moveListItem(items, i, i - 1))}
                >
                  Up
                </Button>
                <Button
                  size="sm"
                  aria-label={`Move ${singular.toLowerCase()} ${i + 1} down`}
                  disabled={i === items.length - 1}
                  onClick={() => onChange(moveListItem(items, i, i + 1))}
                >
                  Down
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={`Remove ${singular.toLowerCase()} ${i + 1}`}
                  onClick={() => onChange(items.filter((_, k) => k !== i))}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2">
        <Button size="sm" onClick={() => onChange([...items, ''])}>
          Add {singular.toLowerCase()}
        </Button>
      </div>
    </div>
  );
}

export interface EditorProps {
  profile: CandidateProfile;
  flagged: (path: string) => boolean;
  /** Applies one change, naming the flag the edit answers. */
  edit: (
    fn: (p: CandidateProfile) => CandidateProfile,
    clears?: string,
    options?: { raise?: boolean },
  ) => void;
  /**
   * Applies a change that moved entries around, and rewrites this list's index-addressed
   * review flags to follow them. `moved` is `oldIndexForNew`; flags for an index missing
   * from it belonged to an entry that was removed and go with it.
   */
  editList: (
    prefix: string,
    fn: (p: CandidateProfile) => CandidateProfile,
    moved?: number[],
    clears?: string,
  ) => void;
}

/** The list-change handler every entry editor hands to `EntryList`. */
function listHandler<T>(
  { edit, editList }: Pick<EditorProps, 'edit' | 'editList'>,
  prefix: string,
  put: (p: CandidateProfile, next: T[]) => CandidateProfile,
) {
  return (next: T[], moved?: number[], clears?: string): void => {
    if (moved) editList(prefix, (p) => put(p, next), moved);
    // , as the education editor does: most fields in here were never flagged,
    // and putting a flag on an entry the extractor was happy with — because someone cleared
    // a date they never had — invents work at a gate that blocks on its list being empty.
    else edit((p) => put(p, next), clears, { raise: false });
  };
}

// ────────────────────────────────────────────────────────────────────── experience

export function ExperienceEditor(props: EditorProps) {
  const { profile, flagged } = props;
  const entries = profile.experience;
  return (
    <EntryList
      label="Experience"
      singular="Entry"
      hint={
        <>
          Paid work, research, volunteering, and every club or team — the reader files them all
          here. <strong>What you did</strong> is the part that matters most: those lines are the
          only thing a generated sentence about this entry can be checked against, and gate G3
          refuses a sentence it cannot trace to one.
        </>
      }
      entries={entries}
      onChange={listHandler(props, 'experience', (p, next) => ({ ...p, experience: next }))}
      blank={(): ExperienceEntry => ({
        organization: '',
        title: '',
        type: 'job',
        bullets: [],
      })}
    >
      {(entry, index, replace) => {
        const path = (field: string) => `experience.${index}.${field}`;
        return (
          <>
            <div className="grid gap-x-8 sm:grid-cols-2">
              <TextField
                label="Title"
                value={entry.title}
                flagged={flagged(path('title'))}
                onChange={(e) => replace({ ...entry, title: e.target.value }, path('title'))}
              />
              <TextField
                label="Organization"
                value={entry.organization}
                flagged={flagged(path('organization'))}
                onChange={(e) =>
                  replace({ ...entry, organization: e.target.value }, path('organization'))
                }
              />
              <SelectField
                label="Kind"
                hint="Only jobs, internships, research and freelance work count toward professional experience. A club is still evidence — it just is not a job."
                value={entry.type}
                flagged={flagged(path('type'))}
                onChange={(e) =>
                  replace(
                    { ...entry, type: e.target.value as ExperienceEntry['type'] },
                    path('type'),
                  )
                }
              >
                {ExperienceType.options.map((type) => (
                  <option key={type} value={type}>
                    {EXPERIENCE_LABELS[type]}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Location"
                hint="City and state, as the resume writes it."
                value={entry.location ?? ''}
                flagged={flagged(path('location'))}
                onChange={(e) =>
                  replace({ ...entry, location: e.target.value || undefined }, path('location'))
                }
              />
              {/* Month rather than day, because the profile stores YYYY-MM and a day it
                  cannot store fails the save on a field nobody typed a day into. */}
              <TextField
                label="Started"
                type="month"
                value={entry.startDate ?? ''}
                flagged={flagged(path('startDate'))}
                onChange={(e) =>
                  replace({ ...entry, startDate: e.target.value || undefined }, path('startDate'))
                }
              />
              <TextField
                label="Finished"
                type="month"
                hint="Leave it empty if you are still there. An empty box means ongoing, and how long the entry ran is measured from it."
                value={entry.endDate ?? ''}
                flagged={flagged(path('endDate'))}
                onChange={(e) =>
                  replace({ ...entry, endDate: e.target.value || undefined }, path('endDate'))
                }
              />
            </div>

            <ListEditor
              label="What you did"
              singular="Line"
              hint="One line per bullet on the resume, written the way you wrote it there."
              items={entry.bullets}
              onChange={(bullets) => replace({ ...entry, bullets }, path('bullets'))}
            />
            <ListEditor
              label="Skills used here"
              singular="Skill"
              items={entry.skills ?? []}
              onChange={(skills) => replace({ ...entry, skills }, path('skills'))}
            />
          </>
        );
      }}
    </EntryList>
  );
}

// ──────────────────────────────────────────────────────────────────────── projects

export function ProjectsEditor(props: EditorProps) {
  const { profile, flagged } = props;
  return (
    <EntryList
      label="Projects"
      singular="Project"
      hint="Anything you built or researched under its own name, rather than a position you held."
      entries={profile.projects}
      onChange={listHandler(props, 'projects', (p, next) => ({ ...p, projects: next }))}
      blank={(): ProjectEntry => ({ name: '', description: '', bullets: [] })}
    >
      {(entry, index, replace) => {
        const path = (field: string) => `projects.${index}.${field}`;
        return (
          <>
            <div className="grid gap-x-8 sm:grid-cols-2">
              <TextField
                label="Name"
                value={entry.name}
                flagged={flagged(path('name'))}
                onChange={(e) => replace({ ...entry, name: e.target.value }, path('name'))}
              />
              <TextField
                label="Address"
                hint="A repo or a page, if there is one. Typing it without https:// is fine."
                value={entry.url ?? ''}
                flagged={flagged(path('url'))}
                onChange={(e) =>
                  replace({ ...entry, url: e.target.value || undefined }, path('url'))
                }
              />
              <TextField
                label="Started"
                type="month"
                value={entry.startDate ?? ''}
                flagged={flagged(path('startDate'))}
                onChange={(e) =>
                  replace({ ...entry, startDate: e.target.value || undefined }, path('startDate'))
                }
              />
              <TextField
                label="Finished"
                type="month"
                value={entry.endDate ?? ''}
                flagged={flagged(path('endDate'))}
                onChange={(e) =>
                  replace({ ...entry, endDate: e.target.value || undefined }, path('endDate'))
                }
              />
            </div>
            <TextField
              label="Description"
              hint="One sentence. This is quoted back to you as evidence, so write what it is rather than how it went."
              value={entry.description}
              flagged={flagged(path('description'))}
              onChange={(e) =>
                replace({ ...entry, description: e.target.value }, path('description'))
              }
            />
            <ListEditor
              label="What you did"
              singular="Line"
              items={entry.bullets}
              onChange={(bullets) => replace({ ...entry, bullets }, path('bullets'))}
            />
            <ListEditor
              label="Skills used here"
              singular="Skill"
              items={entry.skills ?? []}
              onChange={(skills) => replace({ ...entry, skills }, path('skills'))}
            />
          </>
        );
      }}
    </EntryList>
  );
}

// ────────────────────────────────────────────────────────────────────────── skills

/**
 * Skills, one row each.
 *
 * A row rather than a card, because a skill is two short fields and twenty of them stacked as
 * cards is a page nobody scrolls. `evidence` is carried through untouched: it points at where
 * in the profile the skill came from, it is what makes claim verification possible, and it is
 * attached during confirmation rather than typed.
 */
export function SkillsEditor({ profile, flagged, edit, editList }: EditorProps) {
  const skills = profile.skills;
  const replaceAll = (next: Skill[], moved?: number[]) => {
    const put = (p: CandidateProfile) => ({ ...p, skills: next });
    // The corpus flag is cleared and re-raised by the value, not by the interaction: an
    // empty list is not an answer to "the reader found no skills", so `isAnswered` reads an
    // empty array as unanswered and deleting the last skill puts the flag back.
    // `'skills'` on both branches. A removal takes the `moved` path so the index-addressed
    // flags follow the rows, and it must ALSO answer the corpus flag — otherwise adding a
    // skill clears it and removing that skill leaves it cleared.
    if (moved) editList('skills', put, moved, 'skills');
    else edit(put, 'skills');
  };

  return (
    <div className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h3 className="u-eyebrow">Skills</h3>
        <span className="u-data text-faint">
          {skills.length === 0 ? 'none found' : `${skills.length}`}
        </span>
      </div>
      <p className="text-faint u-prose mb-3 text-[0.9375rem] leading-snug">
        These are read when the search plan is built, so a language or a tool missing from here is a
        search that never runs for it.
      </p>

      {skills.length > 0 && (
        <ul className="space-y-2">
          {skills.map((skill, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="u-data text-faint w-6 shrink-0 text-right">{i + 1}</span>
              <input
                value={skill.name}
                aria-label={`Skill ${i + 1}`}
                onChange={(e) =>
                  replaceAll(skills.map((s, k) => (k === i ? { ...s, name: e.target.value } : s)))
                }
                className={`u-data min-w-[10rem] flex-1 rounded-t border-b bg-transparent px-1 py-1.5 outline-none transition-colors ${
                  flagged(`skills.${i}.name`) ? 'border-caution' : 'border-rule focus:border-accent'
                }`}
              />
              <select
                value={skill.category}
                aria-label={`Skill ${i + 1} kind`}
                onChange={(e) =>
                  replaceAll(
                    skills.map((s, k) =>
                      k === i ? { ...s, category: e.target.value as Skill['category'] } : s,
                    ),
                  )
                }
                className="u-data bg-raised text-ink border-rule focus:border-accent shrink-0 rounded border px-2 py-1.5 outline-none transition-colors"
              >
                {SKILL_CATEGORIES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="danger"
                aria-label={`Remove skill ${i + 1}`}
                onClick={() =>
                  replaceAll(
                    skills.filter((_, k) => k !== i),
                    indexRange(skills.length).filter((k) => k !== i),
                  )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        <Button
          size="sm"
          onClick={() => replaceAll([...skills, { name: '', category: 'tool', evidence: [] }])}
        >
          Add skill
        </Button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────── certifications and languages

export function CertificationsEditor(props: EditorProps) {
  const { profile, flagged } = props;
  return (
    <EntryList
      label="Certifications"
      singular="Certification"
      hint="The date is where a claim like “certified for three years” starts counting, so it is worth getting right."
      entries={profile.certifications}
      onChange={listHandler(props, 'certifications', (p, next) => ({ ...p, certifications: next }))}
      blank={(): Certification => ({ name: '' })}
    >
      {(entry, index, replace) => (
        <div className="grid gap-x-8 sm:grid-cols-3">
          <TextField
            label="Name"
            value={entry.name}
            flagged={flagged(`certifications.${index}.name`)}
            onChange={(e) =>
              replace({ ...entry, name: e.target.value }, `certifications.${index}.name`)
            }
          />
          <TextField
            label="Issued by"
            value={entry.issuer ?? ''}
            flagged={flagged(`certifications.${index}.issuer`)}
            onChange={(e) =>
              replace(
                { ...entry, issuer: e.target.value || undefined },
                `certifications.${index}.issuer`,
              )
            }
          />
          <TextField
            label="Earned"
            type="month"
            value={entry.date ?? ''}
            flagged={flagged(`certifications.${index}.date`)}
            onChange={(e) =>
              replace(
                { ...entry, date: e.target.value || undefined },
                `certifications.${index}.date`,
              )
            }
          />
        </div>
      )}
    </EntryList>
  );
}

export function LanguagesEditor(props: EditorProps) {
  const { profile, flagged } = props;
  return (
    <EntryList
      label="Languages"
      singular="Language"
      entries={profile.languages}
      onChange={listHandler(props, 'languages', (p, next) => ({ ...p, languages: next }))}
      blank={() => ({ name: '', proficiency: '' })}
    >
      {(entry, index, replace) => (
        <div className="grid gap-x-8 sm:grid-cols-2">
          <TextField
            label="Language"
            value={entry.name}
            flagged={flagged(`languages.${index}.name`)}
            onChange={(e) => replace({ ...entry, name: e.target.value }, `languages.${index}.name`)}
          />
          <TextField
            label="How well"
            hint="Written the way you would say it: native, fluent, conversational."
            value={entry.proficiency}
            flagged={flagged(`languages.${index}.proficiency`)}
            onChange={(e) =>
              replace({ ...entry, proficiency: e.target.value }, `languages.${index}.proficiency`)
            }
          />
        </div>
      )}
    </EntryList>
  );
}

// ─────────────────────────────────────────────────────────────────────────── links

export function LinksEditor({ profile, flagged, edit }: EditorProps) {
  const links = profile.links;
  /**
   * `raise: false`, because a link the user deliberately emptied is an ANSWER.
   *
   * The default raises a flag for any field left blank, which is right for the six facts G1
   * exists to collect and wrong here: blank is documented as a complete answer for all three
   * of these, so deleting a URL the extractor had misfiled minted a brand-new `links.github`
   * flag, blocked Confirm, and made the user click "I have checked this" on a box they had
   * just emptied on purpose. Even typing one character and backspacing did it. A flag the
   * extractor DID raise still clears the moment a real address is behind it.
   */
  const set = (key: 'github' | 'linkedin' | 'portfolio', value: string) =>
    edit((p) => ({ ...p, links: { ...p.links, [key]: value || undefined } }), `links.${key}`, {
      raise: false,
    });

  return (
    <div className="mt-10">
      <h3 className="u-eyebrow mb-3">Links</h3>
      <p className="text-faint u-prose mb-1 text-[0.9375rem] leading-snug">
        Typed into application forms as they stand. Leaving out https:// is fine — it is added on
        the way to the file.
      </p>
      <div className="grid gap-x-8 sm:grid-cols-3">
        <TextField
          label="GitHub"
          value={links.github ?? ''}
          flagged={flagged('links.github')}
          onChange={(e) => set('github', e.target.value)}
        />
        <TextField
          label="LinkedIn"
          value={links.linkedin ?? ''}
          flagged={flagged('links.linkedin')}
          onChange={(e) => set('linkedin', e.target.value)}
        />
        <TextField
          label="Portfolio"
          value={links.portfolio ?? ''}
          flagged={flagged('links.portfolio')}
          onChange={(e) => set('portfolio', e.target.value)}
        />
      </div>
    </div>
  );
}

/**
 * What the user is actually looking for — the block of the profile that had no interface.
 *
 * Every field here already existed on `ConfirmedProfile.preferences` and every one of them
 * was invisible and uneditable. `industries` feeds the score's domain-match dimension,
 * `excludeCompanies` is meant to keep an employer out of the queue, and `roleFamilies` did
 * not exist at all: the planner INFERRED the role families from the resume and no interface
 * could remove one, so a student whose resume mentions one coding class got software
 * engineering queries for as long as they owned the profile, with the plan's own note telling
 * them to change something they had no way to change.
 *
 * Choosing here replaces the inference outright rather than adding to it. An explicit answer
 * to "what are you looking for" is better evidence than anything read off a resume, and a
 * preference the tool argues with is not a preference. Choosing NOTHING is a real answer too,
 * and it means the old behaviour: read it off the resume.
 */
export function PreferencesEditor({
  preferences,
  inferred,
  onChange,
}: {
  preferences: {
    roleFamilies: string[];
    industries: string[];
    excludeCompanies: string[];
    companySizes: string[];
    minStipend?: number;
  };
  /** What the resume suggests, shown only while the user has chosen nothing themselves. */
  inferred?: string[];
  onChange: (next: Partial<typeof preferences>) => void;
}) {
  const chosen = preferences.roleFamilies;
  const toggle = (family: string): void => {
    onChange({
      roleFamilies: chosen.includes(family)
        ? chosen.filter((f) => f !== family)
        : [...chosen, family],
    });
  };

  return (
    <div className="mt-10">
      <h3 className="u-eyebrow mb-2">What you are looking for</h3>
      <p className="text-faint u-prose mb-5 text-[0.9375rem]">
        {chosen.length > 0
          ? 'Searches use exactly what you pick here. Your resume is not consulted for this.'
          : 'Nothing picked, so this is read off your resume. Pick any and that guess is replaced.'}
      </p>

      {chosen.length === 0 && inferred && inferred.length > 0 && (
        <p className="text-dim u-prose mb-4 text-[0.9375rem]">
          Read off your resume right now: <em>{inferred.join(', ')}</em>. Pick below to override.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {ROLE_FAMILIES.map((family) => {
          const on = chosen.includes(family);
          return (
            <button
              key={family}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(family)}
              className={`rounded border px-3 py-1.5 text-[0.9375rem] transition-colors ${
                on
                  ? 'border-accent bg-accent/15 text-ink'
                  : 'border-rule text-dim hover:border-rule-strong hover:text-ink'
              }`}
            >
              {family}
            </button>
          );
        })}
      </div>

      {chosen.length > 0 && (
        <div className="mt-3">
          <Button size="sm" onClick={() => onChange({ roleFamilies: [] })}>
            Clear, and go back to reading my resume
          </Button>
        </div>
      )}

      <ListEditor
        label="Industries you care about"
        singular="industry"
        hint="Used to rank, never to filter. A posting that matches none is still shown."
        items={preferences.industries}
        onChange={(industries) => onChange({ industries })}
      />

      <ListEditor
        label="Companies to keep out"
        singular="company"
        hint="Postings from these are dropped from your queue."
        items={preferences.excludeCompanies}
        onChange={(excludeCompanies) => onChange({ excludeCompanies })}
      />
    </div>
  );
}
