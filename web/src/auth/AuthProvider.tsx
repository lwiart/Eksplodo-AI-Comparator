import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ApiError, apiFetch, setUnauthorizedHandler } from '../api/client';

export type Role = 'admin' | 'user';

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

export type AuthValue = {
  user: PublicUser | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
};

export const AuthContext = createContext<AuthValue | null>(null);

const ME_KEY = ['auth', 'me'] as const;

async function fetchMe(): Promise<PublicUser | null> {
  try {
    const { user } = await apiFetch<{ user: PublicUser }>('/api/auth/me');
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, retry: false, staleTime: Infinity });

  // Les données d'un utilisateur ne doivent pas survivre à la fin de sa session (un autre utilisateur peut se
  // connecter dans le même onglet). On ne vide pas tout le cache (clear()) : la requête de session, observée en
  // permanence, resterait sur l'ancien utilisateur.
  const clearSession = useCallback(() => {
    queryClient.setQueryData(ME_KEY, null);
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
  }, [queryClient]);

  // Changement d'utilisateur sans passer par la déconnexion (invitation acceptée dans le même navigateur…) :
  // les données de l'ancien utilisateur ne doivent pas rester en cache.
  const userId = me.data?.id ?? null;
  const previousUserId = useRef<string | null>(null);
  useEffect(() => {
    if (previousUserId.current !== null && previousUserId.current !== userId) {
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
    }
    previousUserId.current = userId;
  }, [userId, queryClient]);

  // Toute réponse 401 (session expirée, révoquée) déconnecte l'interface ; les routes protégées
  // redirigent alors vers /connexion, les pages publiques restent affichées (pas de boucle).
  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const { user } = await apiFetch<{ user: PublicUser }>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      queryClient.setQueryData(ME_KEY, user);
    },
    [queryClient],
  );

  // L'interface n'est déconnectée qu'une fois la session fermée côté serveur (ou déjà invalide : 401).
  // Tout autre échec remonte à l'appelant, qui le signale : la session serveur est toujours ouverte.
  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err;
    }
    clearSession();
  }, [clearSession]);

  const refresh = useCallback(async () => {
    await queryClient.fetchQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 0 });
  }, [queryClient]);

  const value = useMemo<AuthValue>(
    () => ({ user: me.data ?? null, loading: me.isPending, login, logout, refresh }),
    [me.data, me.isPending, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth doit être utilisé sous <AuthProvider>');
  return value;
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  user: 'Utilisateur',
};
