import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../auth/AuthProvider';
import { AccessDeniedPage } from '../pages/AccessDeniedPage';
import { AccountPage } from '../pages/AccountPage';
import { DashboardPage } from '../pages/DashboardPage';
import { InvitationPage } from '../pages/InvitationPage';
import { LoginPage } from '../pages/LoginPage';
import { ErrorLogPage } from '../pages/admin/ErrorLogPage';
import { UsersPage } from '../pages/admin/UsersPage';
import { ResetPasswordPage } from '../pages/ResetPasswordPage';
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

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnlyWhileLoading />}>
        <Route path="/connexion" element={<LoginPage />} />
        <Route path="/invitation/:token" element={<InvitationPage />} />
        <Route path="/reinitialiser/:token" element={<ResetPasswordPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="/compte" element={<AccountPage />} />
          <Route element={<RequireRole roles={['admin']} />}>
            <Route path="/admin/utilisateurs" element={<UsersPage />} />
            <Route path="/admin/erreurs" element={<ErrorLogPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
