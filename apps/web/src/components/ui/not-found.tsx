import { Link, useRouterState, type LinkOptions } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useHeadingFocus } from '../heading-focus.ts';
import { buttonClass } from './button.tsx';
import { Code } from './code.tsx';
import { EmptyState } from './empty-state.tsx';
import { Icon } from './icons.tsx';

/**
 * The pages for what is not there (UX-1e, #317; design system 4.11, G-21, N-07), one pattern:
 * a back link ("‹ All orders", 3.3) as the way on, the page's `h1` (focused after a navigation)
 * and an `EmptyState` that says what is missing and why.
 *
 * - `NotFound`: an id the MES does not know. The heading is the id as asked ("Order PO-NOPE"),
 *   the block "No order PO-NOPE", "The MES has no order with this id."
 * - `PageNotFound`: the router's page for an unknown address ("Page not found").
 * - `Forbidden`: a page the role may not open (the console's, the users'), naming the permission.
 */
export interface BackLink {
  readonly to: NonNullable<LinkOptions['to']>;
  /** The parent's name: "All orders", "Plant overview". */
  readonly label: string;
}

function BackTo({ back }: { readonly back: BackLink }) {
  return (
    <Link
      to={back.to}
      className="inline-flex min-h-6 items-center gap-1 text-sm text-link underline-offset-4 hover:underline"
    >
      <Icon name="chevron-left" size={16} />
      {back.label}
    </Link>
  );
}

function MissingPage({
  back,
  heading,
  children,
}: {
  readonly back: BackLink;
  readonly heading: ReactNode;
  readonly children: ReactNode;
}) {
  const ref = useHeadingFocus<HTMLHeadingElement>();
  return (
    <section className="flex flex-col gap-1">
      <BackTo back={back} />
      <h1 ref={ref} tabIndex={-1} className="text-xl font-semibold text-ink">
        {heading}
      </h1>
      <div className="mt-6 rounded-lg border border-line bg-surface">{children}</div>
    </section>
  );
}

const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export interface NotFoundProps {
  /** What was asked for, lower case: "order", "carton", "hold". */
  readonly kind: string;
  readonly id: string;
  readonly back: BackLink;
  /** One more sentence after "The MES has no … with this id.": why it may not exist yet. */
  readonly detail?: string | undefined;
  readonly testId?: string | undefined;
}

export function NotFound({ kind, id, back, detail, testId }: NotFoundProps) {
  return (
    <MissingPage
      back={back}
      heading={
        <>
          {capitalised(kind)} <Code>{id}</Code>
        </>
      }
    >
      <EmptyState
        size="page"
        icon="search"
        testId={testId}
        title={
          <>
            No {kind} <Code>{id}</Code>
          </>
        }
        body={`The MES has no ${kind} with this id.${detail === undefined ? '' : ` ${detail}`}`}
      />
    </MissingPage>
  );
}

/** The router's page for an address that is no page (`notFoundComponent`). */
export function PageNotFound() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const back: BackLink = { to: '/', label: 'Plant overview' };
  return (
    <MissingPage back={back} heading="Page not found">
      <EmptyState
        size="page"
        icon="search"
        title="Nothing at this address"
        body={
          <>
            <Code>{pathname}</Code> is not a page of ShopFloor Twin. Check the address, or go back
            to the plant overview.
          </>
        }
      />
    </MissingPage>
  );
}

export interface ForbiddenProps {
  /** Who may, as the screen says it today: "Only an admin drives the simulation". */
  readonly children: ReactNode;
  /** The permission id, kept in the text (`console/2-actions.spec.ts` reads `sim:control`). */
  readonly permission: string;
  readonly testId?: string | undefined;
}

/**
 * The no-permission block under a screen's own heading, which has no back link: the way on is
 * the button to the plant overview. Announced (`role="alert"`) as the sentence it replaces was.
 */
export function Forbidden({ children, permission, testId }: ForbiddenProps) {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <EmptyState
        size="page"
        icon="ban"
        role="alert"
        testId={testId}
        title="Not available for your role"
        body={
          <p>
            {children} (permission <Code>{permission}</Code>).
          </p>
        }
        action={
          <Link to="/" className={buttonClass({ variant: 'secondary' })}>
            Back to the plant overview
          </Link>
        }
      />
    </div>
  );
}
