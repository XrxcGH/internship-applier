import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

export function Button({
  children,
  variant = 'ghost',
  ...rest
}: {
  children: ReactNode;
  variant?: 'primary' | 'ghost';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    'u-data px-4 py-2 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed tracking-wide uppercase';
  const styles =
    variant === 'primary'
      ? 'border-brass text-brass hover:bg-brass/10'
      : 'border-rule text-dim hover:text-ink hover:border-dim';
  return (
    <button {...rest} className={`${base} ${styles} ${rest.className ?? ''}`}>
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
    <label className="block py-2.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[0.9375rem]">{label}</span>
        {flagged && (
          <span className="u-data text-caution text-[0.6875rem] tracking-widest uppercase">
            check this
          </span>
        )}
      </span>
      {hint && <span className="text-faint mt-0.5 block text-[0.8125rem]">{hint}</span>}
      <input
        {...rest}
        className={`u-data mt-1.5 w-full bg-transparent px-0 py-1.5 outline-none border-b ${
          flagged ? 'border-caution' : 'border-rule focus:border-brass'
        } ${rest.className ?? ''}`}
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
    <label className="block py-2.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[0.9375rem]">{label}</span>
        {flagged && (
          <span className="u-data text-caution text-[0.6875rem] tracking-widest uppercase">
            check this
          </span>
        )}
      </span>
      {hint && <span className="text-faint mt-0.5 block text-[0.8125rem]">{hint}</span>}
      <select
        {...rest}
        className={`u-data bg-raised text-ink mt-1.5 w-full px-2 py-2 outline-none border ${
          flagged ? 'border-caution' : 'border-rule focus:border-brass'
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
  tone: 'caution' | 'redline' | 'verified';
  children: ReactNode;
}) {
  const color = `var(--${tone})`;
  return (
    <div
      className="my-4 border-l py-2 pl-4 text-[0.9375rem]"
      style={{ borderColor: color, color: 'var(--ink-dim)' }}
    >
      {children}
    </div>
  );
}
