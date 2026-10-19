import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Switch from '@radix-ui/react-switch';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useErrorSummary } from '../api/errors';
import { messageForError } from '../api/messages';
import { TODO_KEY, countToScore, getTodo } from '../api/scoring';
import { ROLE_LABELS, useAuth, type PublicUser } from '../auth/AuthProvider';
import { InfoTip } from '../components/ui/InfoTip';
import {
  applyAnimationsPreference,
  applyThemePreference,
  getAnimationsPreference,
  getThemePreference,
  setAnimationsPreference,
  setThemePreference,
} from './preferences';

/** `pinned` : entrée gardée en tête de sa section, hors du tri alphabétique ; `help` : courte description (icône « ? »). */
type NavItem = { to: string; label: string; icon: string; help: string; end?: boolean; pinned?: boolean; badge?: number; badgeLabel?: string };

const EXPLORE: NavItem[] = [
  {
    to: '/',
    label: 'Tableau de bord',
    icon: '◎',
    end: true,
    pinned: true,
    help: 'Vue d’ensemble : dernières séries, dépenses du mois et évolution de la qualité des modèles.',
  },
  { to: '/series', label: 'Séries', icon: '▶', help: 'Les comparatifs : des tests passés sur plusieurs modèles, avec leurs réponses, leurs notes et leur classement.' },
  { to: '/modeles', label: 'Modèles', icon: '✦', help: 'Catalogue des modèles disponibles : prix, capacités et statistiques de chacun.' },
];
const TO_SCORE: NavItem = {
  to: '/a-noter',
  label: 'À noter',
  icon: '✎',
  help: 'Les questions qui attendent vos notes manuelles, données à l’aveugle sans voir le nom des modèles.',
};
const ADMIN: NavItem[] = [
  { to: '/admin/utilisateurs', label: 'Utilisateurs', icon: '☻', help: 'Comptes, rôles et invitations par e-mail.' },
  {
    to: '/admin/fournisseurs',
    label: 'Fournisseurs',
    icon: '⌁',
    help: 'Connexions aux API des fournisseurs d’IA (clés chiffrées), ajout de modèles et juge par défaut.',
  },
  { to: '/admin/tests', label: 'Tests', icon: '✎', help: 'Les questions posées aux modèles : prompt, pièces jointes et méthode de notation.' },
  { to: '/admin/suites', label: 'Suites', icon: '☰', help: 'Listes ordonnées de tests à lancer ensemble dans une série.' },
  { to: '/admin/partages', label: 'Liens de partage', icon: '⇪', help: 'Liens publics en lecture seule vers les résultats d’une série, à activer ou couper.' },
  { to: '/admin/erreurs', label: 'Journal des erreurs', icon: '⚠', help: 'Erreurs techniques de l’application, à consulter puis marquer comme traitées.' },
];

function Brand() {
  return (
    <Link to="/" className="mx-1.5 mb-6 flex items-center gap-2.5 text-white no-underline" aria-label="Eksplodo, accueil">
      <img src="/logo-icon-white.png" alt="Eksplodo" className="logo-glow block h-[34px] w-auto" />
      <span className="font-mono text-[17px] leading-tight font-semibold tracking-[0.01em]">
        Eksplodo
        <small className="block font-mono text-[10px] font-medium tracking-[0.06em] text-mute">COMPARATEUR IA</small>
      </span>
    </Link>
  );
}

/** Entrées épinglées d'abord, puis ordre alphabétique français (« À noter » avec les « a ») : une nouvelle entrée se range d'elle-même. */
const byLabel = (a: NavItem, b: NavItem) =>
  Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' });

function NavSection({ title, items, onNavigate }: { title: string; items: NavItem[]; onNavigate?: () => void }) {
  return (
    <>
      <div className="mx-2 mt-[18px] mb-2 font-mono text-[10px] font-semibold tracking-[0.12em] text-mute">{title}</div>
      {[...items].sort(byLabel).map((item) => (
        // L'aide est à côté du lien, pas dedans : un bouton ne peut pas être imbriqué dans un lien.
        <div key={item.to} className="relative flex items-center">
          <NavLink
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] py-[9px] pr-8 pl-2.5 text-sm no-underline transition-colors ${
                isActive
                  ? 'bg-gradient-to-r from-orange/20 to-orange/[0.02] text-white shadow-[inset_2px_0_0_var(--color-orange)]'
                  : 'text-ink hover:bg-blue/10'
              }`
            }
          >
            <span aria-hidden="true" className="w-[18px] text-center opacity-85">
              {item.icon}
            </span>
            {item.label}
            {item.badge ? (
              <span
                className="ml-auto rounded-full bg-bad/20 px-2 py-0.5 font-mono text-[11px] font-semibold text-bad"
                aria-label={`${item.badge} ${item.badgeLabel ?? ''}`.trim()}
              >
                {item.badge}
              </span>
            ) : null}
          </NavLink>
          <span className="absolute right-2">
            <InfoTip label={item.label} align="right" width="w-[196px]">
              {item.help}
            </InfoTip>
          </span>
        </div>
      ))}
    </>
  );
}

function AccountMenu({ user, onNavigate }: { user: PublicUser; onNavigate?: () => void }) {
  const { logout } = useAuth();
  const [animations, setAnimations] = useState(getAnimationsPreference);
  const [light, setLight] = useState(() => getThemePreference() === 'light');
  const [logoutError, setLogoutError] = useState<string | null>(null);

  // La session serveur reste ouverte si la déconnexion échoue : on le signale au lieu d'ignorer l'échec.
  async function handleLogout() {
    setLogoutError(null);
    try {
      await logout();
    } catch (err) {
      setLogoutError(messageForError(err));
    }
  }

  function toggleAnimations(on: boolean) {
    setAnimations(on);
    setAnimationsPreference(on);
    applyAnimationsPreference(on);
  }

  function toggleLight(on: boolean) {
    setLight(on);
    setThemePreference(on ? 'light' : 'dark');
    applyThemePreference(on ? 'light' : 'dark');
  }

  const toggle = (checked: boolean) => (
    <Switch.Root
      checked={checked}
      tabIndex={-1}
      aria-hidden="true"
      className="pointer-events-none relative h-5 w-9 rounded-full border border-line-strong bg-night-2 data-[state=checked]:border-orange data-[state=checked]:bg-orange"
    >
      <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-[#fff] shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </Switch.Root>
  );

  const item =
    'flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink no-underline outline-none data-[highlighted]:bg-blue/15 data-[highlighted]:text-white';

  return (
    <>
    {logoutError ? (
      <p role="alert" className="m-0 mb-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
        {logoutError}
      </p>
    ) : null}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-transparent p-2.5 text-left text-[13px] text-ink"
        >
          <span aria-hidden="true" className="h-[30px] w-[30px] shrink-0 rounded-full bg-gradient-to-br from-blue-deep to-orange" />
          <span className="min-w-0">
            <b className="block truncate text-white">{user.name}</b>
            <span className="text-[11px] text-mute">{ROLE_LABELS[user.role]}</span>
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={8}
          className="card-surface z-[60] min-w-52 bg-night-1 p-1.5 shadow-2xl"
        >
          <DropdownMenu.Item asChild>
            <Link to="/compte" className={item} onClick={onNavigate}>
              Mon compte
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.CheckboxItem
            checked={animations}
            onCheckedChange={toggleAnimations}
            onSelect={(e) => e.preventDefault()}
            className={`${item} justify-between`}
          >
            Animations
            {toggle(animations)}
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            checked={light}
            onCheckedChange={toggleLight}
            onSelect={(e) => e.preventDefault()}
            className={`${item} justify-between`}
          >
            Mode clair
            {toggle(light)}
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={item} onSelect={() => void handleLogout()}>
            Déconnexion
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    </>
  );
}

/** Entrées Admin, avec le nombre d'erreurs graves non traitées à côté du journal (rien s'il n'y en a pas). */
function AdminSection({ onNavigate }: { onNavigate?: () => void }) {
  const summary = useErrorSummary();
  const unresolved = summary.data?.unresolvedGrave ?? 0;
  const items = ADMIN.map((i) => (i.to === '/admin/erreurs' && unresolved > 0 ? { ...i, badge: unresolved } : i));
  return <NavSection title="ADMIN" items={items} onNavigate={onNavigate} />;
}

/** Entrées EXPLORER, avec le nombre de questions que le compte doit encore noter (rafraîchi toutes les 60 s). */
function ExploreSection({ onNavigate }: { onNavigate?: () => void }) {
  const todo = useQuery({ queryKey: TODO_KEY, queryFn: getTodo, refetchInterval: 60_000 });
  const pending = countToScore(todo.data ?? []);
  const items = [...EXPLORE, pending > 0 ? { ...TO_SCORE, badge: pending, badgeLabel: pending > 1 ? 'questions à noter' : 'question à noter' } : TO_SCORE];
  return <NavSection title="EXPLORER" items={items} onNavigate={onNavigate} />;
}

function SidebarBody({ user, onNavigate }: { user: PublicUser; onNavigate?: () => void }) {
  return (
    <>
      <Brand />
      <nav aria-label="Navigation principale" className="flex-1 overflow-y-auto">
        <ExploreSection onNavigate={onNavigate} />
        {user.role === 'admin' ? <AdminSection onNavigate={onNavigate} /> : null}
      </nav>
      <NavLink
        to="/aide"
        onClick={onNavigate}
        className={({ isActive }) =>
          `mb-2 flex items-center gap-2.5 rounded-[10px] py-[9px] pl-2.5 text-sm no-underline transition-colors ${
            isActive ? 'bg-gradient-to-r from-orange/20 to-orange/[0.02] text-white shadow-[inset_2px_0_0_var(--color-orange)]' : 'text-ink hover:bg-blue/10'
          }`
        }
      >
        <span aria-hidden="true" className="w-[18px] text-center opacity-85">
          ?
        </span>
        Aide
      </NavLink>
      <AccountMenu user={user} onNavigate={onNavigate} />
    </>
  );
}

const SIDEBAR = 'flex flex-col border-r border-line bg-night-0/55 px-3.5 py-5 backdrop-blur-lg';

/** Coque de l'application : barre latérale (tiroir sous 800 px) et zone de contenu. */
export function AppShell({ children }: { children?: ReactNode }) {
  const { user } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  if (!user) return null;

  return (
    <div className="relative min-h-screen min-[800px]:flex">
      <aside className={`${SIDEBAR} no-print sticky top-0 hidden h-screen w-[232px] shrink-0 min-[800px]:flex`}>
        <SidebarBody user={user} />
      </aside>

      <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <header className="no-print flex items-center justify-between border-b border-line bg-night-0/55 px-4 py-2.5 backdrop-blur-lg min-[800px]:hidden">
          <Link to="/" className="font-mono text-[15px] font-semibold text-white no-underline">
            Eksplodo
          </Link>
          <Dialog.Trigger asChild>
            <button
              type="button"
              aria-label="Ouvrir le menu"
              className="cursor-pointer rounded-full border border-line-strong bg-night-2/70 px-3 py-1.5 text-sm text-white"
            >
              <span aria-hidden="true">☰</span>
            </button>
          </Dialog.Trigger>
        </header>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-night-0/70 backdrop-blur-sm min-[800px]:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className={`${SIDEBAR} fixed inset-y-0 left-0 z-50 w-[260px] bg-night-1 shadow-2xl min-[800px]:hidden`}
          >
            <Dialog.Title className="sr-only">Menu</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Fermer le menu"
                className="mb-2 self-end cursor-pointer rounded-full border border-line-strong bg-night-2/70 px-3 py-1 text-sm text-white"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </Dialog.Close>
            <SidebarBody user={user} onNavigate={() => setDrawerOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* `app-main` : imprimé sur fond blanc, textes sombres (theme.css), menu masqué. */}
      <main className="app-main min-w-0 flex-1 px-4 pt-[22px] pb-[60px] min-[800px]:px-7">{children ?? <Outlet />}</main>
    </div>
  );
}
