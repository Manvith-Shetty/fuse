import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Buffer } from 'buffer';
import { App } from './App';
import { EventsProvider } from './hooks/events';
import { Router } from './lib/router';
import './index.css';

// Wallet libraries expect Node globals in the browser: Buffer (NEP-413 nonces), `global` and a `process.env`.
const g = globalThis as { Buffer?: unknown; global?: unknown; process?: { env?: Record<string, string | undefined> } };
if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;
if (!g.process) g.process = { env: {} };

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <EventsProvider>
        <Router>
          <App />
        </Router>
      </EventsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
