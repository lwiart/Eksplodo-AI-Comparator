import { useId, type InputHTMLAttributes } from 'react';

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  label: string;
  error?: string | null;
  hint?: string;
};

/** Champ de formulaire avec libellé, aide et message d'erreur associés. */
export function Field({ label, error, hint, className = '', ...rest }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`rounded-xl border bg-night-0/60 px-3 py-2.5 text-sm text-white placeholder:text-mute/70 ${
          error ? 'border-bad/60' : 'border-line-strong'
        } ${className}`}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="m-0 text-xs text-mute">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="m-0 text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
