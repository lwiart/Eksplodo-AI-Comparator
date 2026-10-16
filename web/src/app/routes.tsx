import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../auth/AuthProvider';
import { AccessDeniedPage } from '../pages/AccessDeniedPage';
import { DashboardPage } from '../pages/DashboardPage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { AppShell } from './AppShell';

function Splash() {
  return (
    <div role="status" className="flex min-h-screen items-center justify-center">
      <img src="/logo-icon-white.png" alt="" className="logo-glow h-12 w-auto" />
      <span className="sr-only">Chargement…</span>
    </div>
  );
}

/** Garde des routes protégées : sans session, renvoie vers /connexion en mémorisant la page demandée. */
function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Splash />;
  if (!user) {
    return <Navigate to="/connexion" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <Outlet />;
}

/** Garde par rôle, sous RequireAuth : un rôle non autorisé voit « Accès refusé » (l'API refuserait ses requêtes). */
function RequireRole({ roles }: { roles: readonly Role[] }) {
  const { user } = useAuth();
  return user && roles.includes(user.role) ? <Outlet /> : <AccessDeniedPage />;
}

/** Les pages publiques attendent la session pour éviter un aller-retour visible vers l'accueil. */
function PublicOnlyWhileLoading() {
  const { loading } = useAuth();
  return loading ? <Splash /> : <Outlet />;
}

// Les pages provisoires sont remplacées par les vraies pages dans les Tasks 8 et 9.
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnlyWhileLoading />}>
        <Route path="/connexion" element={<PlaceholderPage title="Connexion" publicPage />} />
        <Route path="/invitation/:token" element={<PlaceholderPage title="Activer mon compte" publicPage />} />
        <Route path="/reinitialiser/:token" element={<PlaceholderPage title="Nouveau mot de passe" publicPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="/compte" element={<PlaceholderPage title="Mon compte" />} />
          <Route element={<RequireRole roles={['admin']} />}>
            <Route path="/admin/utilisateurs" element={<PlaceholderPage title="Utilisateurs" />} />
            <Route path="/admin/erreurs" element={<PlaceholderPage title="Journal des erreurs" />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
