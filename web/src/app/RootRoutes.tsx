import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider';
import { AppRoutes } from './routes';

/** Page publique chargée à la demande : Recharts et Three.js restent hors du fragment principal. */
const PublicSharePage = lazy(() => import('../pages/PublicSharePage'));

/**
 * Routes de premier niveau. `/p/:token` est rendue hors d'`AuthProvider` : la page publique ne lit jamais la session
 * et n'appelle aucune route `/api/*`.
 */
export function RootRoutes() {
  return (
    <Routes>
      <Route
        path="/p/:token"
        element={
          <Suspense
            fallback={
              <div role="status" className="py-24 text-center text-sm text-mute">
                Chargement…
              </div>
            }
          >
            <PublicSharePage />
          </Suspense>
        }
      />
      <Route
        path="/*"
        element={
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        }
      />
    </Routes>
  );
}
