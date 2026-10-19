import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { applyAnimationsPreference, applyThemePreference, getAnimationsPreference, getThemePreference } from './app/preferences';
import { RootRoutes } from './app/RootRoutes';
import './theme/theme.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

applyAnimationsPreference(getAnimationsPreference());
applyThemePreference(getThemePreference());

const root = document.getElementById('root');
if (!root) throw new Error('élément #root introuvable');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <RootRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
