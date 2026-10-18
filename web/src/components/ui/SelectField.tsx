import { useId, type SelectHTMLAttributes } from 'react';

type Option = { value: string; label: string };

/**
 * Liste déroulante avec libellé associé, au style des champs « Nuit ». Elle ne dépasse jamais son conteneur : une option
 * très longue (nom de test, de modèle) est tronquée au lieu d'élargir la liste au-delà de l'écran.
 */
export function SelectField({
  label,
  options,
  className = '',
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'children'> & { label: string; options: Option[] }) {
  const id = useId();
  return (
    <div className="flex max-w-full min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        className={`max-w-full min-w-0 truncate rounded-xl border border-line-strong bg-night-0/60 px-3 py-2.5 text-sm text-white ${className}`}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
