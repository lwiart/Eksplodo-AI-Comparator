import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';

/** Affichée quand un utilisateur connecté ouvre une page réservée aux Admins (lien partagé, favori…). */
export function AccessDeniedPage() {
  return (
    <div>
      <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Accès refusé</h1>
      <p className="mt-2 mb-5 max-w-[60ch] text-sm text-mute">
        Cette page est réservée aux administrateurs. Votre menu ne propose que les pages ouvertes à votre compte.
      </p>
      <Link to="/" className="no-underline">
        <Button variant="secondary">Retour au tableau de bord</Button>
      </Link>
    </div>
  );
}
