import { useId, type TextareaHTMLAttributes } from 'react';

type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & {
  label: string;
  error?: string | null;
  hint?: string;
};

/** Zone de texte multiligne, au même style et avec les mêmes associations d'accessibilité que `Field`. */
export function TextArea({ label, error, hint, className = '', rows = 4, ...rest }: TextAreaProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`resize-y rounded-xl border bg-night-0/60 px-3 py-2.5 text-sm leading-relaxed text-white placeholder:text-mute/70 ${
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
