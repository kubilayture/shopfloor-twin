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
const live = new LiveClient({ url: sameOriginWsUrl(`${API_BASE}/ws`) });
connectLiveToCache(live, queryClient);
live.start();

createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} live={live} />
  </StrictMode>,
);
