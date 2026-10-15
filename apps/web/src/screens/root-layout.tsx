import { STATES_TOPIC } from '@shopfloor/contracts/mes-api';
import { Link, Outlet } from '@tanstack/react-router';
import { usePlantClock } from '../api/queries.ts';
import { ConnectionStatus } from '../components/connection-status.tsx';
import { formatPlantTime } from '../domain/time.ts';
import { useLiveSubscription } from '../live/live-context.tsx';

function PlantClock() {
  const { clock, site } = usePlantClock();
  return (
    <p className="text-sm" data-testid="plant-clock">
      <span className="text-slate-300">{site ? `${site.name} plant time` : 'Plant time'}: </span>
      {clock ? (
        <time dateTime={clock.watermark} className="font-mono font-semibold tabular-nums">
          {formatPlantTime(clock.watermark)}
        </time>
      ) : (
        <span>no data yet</span>
      )}
    </p>
  );
}

export function RootLayout() {
  useLiveSubscription(STATES_TOPIC);
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="bg-slate-900 text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="text-lg font-bold hover:underline">
            ShopFloor Twin <span className="font-normal text-slate-300">MES</span>
          </Link>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <PlantClock />
            <ConnectionStatus />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 focus:outline-none">
        <Outlet />
      </main>
    </div>
  );
}

export function NotFound() {
  return (
    <section>
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="mt-2">
        <Link to="/" className="text-sky-800 underline">
          Back to the plant overview
        </Link>
      </p>
    </section>
  );
}
