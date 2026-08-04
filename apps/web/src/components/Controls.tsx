import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

type Variant = 'solid' | 'primary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  // Reserved for the one action a screen is actually about.
  solid: 'border-accent bg-accent/15 text-accent hover:bg-accent/25',
  primary: 'border-accent/60 text-accent hover:bg-accent/10 hover:border-accent',
  ghost: 'border-rule text-dim hover:text-ink hover:border-rule-strong hover:bg-ink/[0.04]',
  danger: 'border-redline/60 text-redline hover:bg-redline/10 hover:border-redline',
};

export function Button({
  children,
  variant = 'ghost',
  size = 'md',
  ...rest
}: {
  children: ReactNode;
  variant?: Variant;
  size?: 'sm' | 'md';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    'u-data inline-flex items-center gap-2 rounded border tracking-wide uppercase ' +
    'transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';
  const pad = size === 'sm' ? 'px-2.5 py-1' : 'px-4 py-2';
  return (
    <button {...rest} className={`${base} ${pad} ${VARIANTS[variant]} ${rest.className ?? ''}`}>
      {children}
    </button>
  );
}

/**
 * `flagged` marks a field the extractor was unsure about. It stays amber until the
 * user touches it — that's what makes gate G1 a real review rather than a click-through.
 */
export function TextField({
  label,
  hint,
  flagged,
  ...rest
}: {
  label: string;
  hint?: string;
  flagged?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block py-3">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[0.9375rem]">{label}</span>
        {flagged && (
          <span className="u-data text-caution text-[0.6875rem] tracking-widest uppercase">
            check this
          </span>
        )}
      </span>
      {hint && <span className="text-faint mt-1 block text-[0.8125rem] leading-snug">{hint}</span>}
      <input
        {...rest}
        className={`u-data mt-2 w-full rounded-t border-b bg-transparent px-1 py-2 outline-none transition-colors ${
          flagged ? 'border-caution' : 'border-rule focus:border-accent'
        } ${rest.className ?? ''}`}
      />
    </label>
  );
}

export function TextArea({
  label,
  hint,
  rows = 8,
  ...rest
}: {
  label?: string;
  hint?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="block">
      {label && <span className="u-eyebrow mb-2 block">{label}</span>}
      {hint && <span className="text-faint mb-2 block text-[0.8125rem]">{hint}</span>}
      <textarea
        {...rest}
        rows={rows}
        className={`border-rule focus:border-accent w-full resize-y rounded border bg-transparent p-4 leading-relaxed outline-none transition-colors ${rest.className ?? ''}`}
      />
    </label>
  );
}

export function SelectField({
  label,
  hint,
  flagged,
  children,
  ...rest
}: {
  label: string;
  hint?: string;
  flagged?: boolean;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="block py-3">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[0.9375rem]">{label}</span>
        {flagged && (
          <span className="u-data text-caution text-[0.6875rem] tracking-widest uppercase">
            check this
          </span>
        )}
      </span>
      {hint && <span className="text-faint mt-1 block text-[0.8125rem] leading-snug">{hint}</span>}
      <select
        {...rest}
        className={`u-data bg-raised text-ink mt-2 w-full rounded border px-2.5 py-2 outline-none transition-colors ${
          flagged ? 'border-caution' : 'border-rule focus:border-accent'
        }`}
      >
        {children}
      </select>
    </label>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: 'caution' | 'redline' | 'verified' | 'accent';
  children: ReactNode;
}) {
  return (
    <div className={`u-tint-${tone} text-dim my-4 rounded px-4 py-3 text-[0.9375rem]`}>
      {children}
    </div>
  );
}

/** A small state label. Always paired with words — colour never carries meaning alone. */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'verified' | 'caution' | 'redline' | 'accent';
  children: ReactNode;
}) {
  // Tone colours go through inline style rather than interpolated class names: Tailwind's
  // JIT only emits classes it can see as literals, so `border-${tone}/40` compiles to
  // nothing at all.
  return (
    <span
      className={`u-data inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.6875rem] tracking-widest uppercase ${
        tone === 'neutral' ? 'border-rule text-faint' : ''
      }`}
      style={
        tone === 'neutral'
          ? undefined
          : {
              color: `var(--${tone})`,
              borderColor: `color-mix(in srgb, var(--${tone}) 40%, transparent)`,
              background: `color-mix(in srgb, var(--${tone}) 10%, transparent)`,
            }
      }
    >
      {children}
    </span>
  );
}

/** Empty states say what to do next, never just "nothing here". */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="u-card-flat px-6 py-12 text-center">
      <p className="text-dim">{title}</p>
      {children && <div className="text-faint mt-3 text-[0.9375rem]">{children}</div>}
    </div>
  );
}
