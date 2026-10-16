import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { applyAnimationsPreference, getAnimationsPreference } from './app/preferences';
import { AppRoutes } from './app/routes';
import { AuthProvider } from './auth/AuthProvider';
import './theme/theme.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

applyAnimationsPreference(getAnimationsPreference());

const root = document.getElementById('root');
if (!root) throw new Error('élément #root introuvable');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
