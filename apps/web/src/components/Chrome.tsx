import type { ReactNode } from 'react';

/** Running head — this is a document header, not a nav bar. */
export function RunningHead({ section, gate }: { section: string; gate?: string }) {
  return (
    <header className="a-rise a-step-1 mb-14">
      <div className="flex items-baseline justify-between gap-4">
        <span className="u-eyebrow">internship&nbsp;·&nbsp;applier</span>
        <span className="u-eyebrow">{gate ? `gate ${gate}` : 'no gate pending'}</span>
      </div>
      <hr className="u-rule a-draw a-step-2 mt-2" />
      <h1 className="u-display mt-6 text-5xl sm:text-6xl">{section}</h1>
    </header>
  );
}

/** Numbered section, like a clause in a file. */
export function Section({
  n,
  title,
  step,
  children,
}: {
  n: string;
  title: string;
  step: number;
  children: ReactNode;
}) {
  return (
    <section className={`a-rise a-step-${step} mb-12`}>
      <div className="mb-3 flex items-baseline gap-3">
        <span className="u-data text-faint">{n}</span>
        <h2 className="u-eyebrow">{title}</h2>
      </div>
      <hr className={`u-rule a-draw a-step-${step} mb-5`} />
      {children}
    </section>
  );
}

export function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-1.5">
      <span className="text-dim text-[0.9375rem]">{label}</span>
      <span className="u-data text-right" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}
