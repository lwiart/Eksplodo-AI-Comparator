import { AuthLayout } from '../app/AuthLayout';

/** Page provisoire : remplacée par la vraie page dans les Tasks 8 et 9. */
export function PlaceholderPage({ title, publicPage = false }: { title: string; publicPage?: boolean }) {
  if (publicPage) return <AuthLayout title={title} intro="À venir" />;
  return (
    <div>
      <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">{title}</h1>
      <p className="mt-2 text-sm text-mute">À venir</p>
    </div>
  );
}
