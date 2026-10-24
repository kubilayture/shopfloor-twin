// First: Zod's config must be set before any schema is built (#338, zod-config.ts).
import './zod-config.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { API_BASE } from './api/client.ts';
import { App, createQueryClient } from './app.tsx';
import './index.css';
import { connectLiveToCache } from './live/live-cache.ts';
import { LiveClient, sameOriginWsUrl } from './live/live-client.ts';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

const queryClient = createQueryClient();
// Started once a session is known (#170): without one the MES would close it with 4401.
const live = new LiveClient({ url: sameOriginWsUrl(`${API_BASE}/ws`) });
connectLiveToCache(live, queryClient);

createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} live={live} />
  </StrictMode>,
);
