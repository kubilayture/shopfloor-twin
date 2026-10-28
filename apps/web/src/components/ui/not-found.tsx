import { Link, useRouterState, type LinkOptions } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { buttonClass } from './button.tsx';
import { Code } from './code.tsx';
import { EmptyState } from './empty-state.tsx';
import { PageHeader } from './page-header.tsx';

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

function MissingPage({
  back,
  heading,
  documentTitle,
  children,
}: {
  readonly back: BackLink;
  readonly heading: ReactNode;
  readonly documentTitle: string;
  readonly children: ReactNode;
}) {
  // The same header as every other page (3.3): "‹ <parent>", the `h1` focused after a navigation.
  // A `section`, as before: a unit test finds the page by `closest('section')`.
  return (
    <section>
      <PageHeader
        title={heading}
        documentTitle={documentTitle}
        back={{ label: back.label, link: { to: back.to } }}
      />
      <div className="rounded-lg border border-line bg-surface">{children}</div>
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
      documentTitle={`${capitalised(kind)} ${id}`}
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
    <MissingPage back={back} heading="Page not found" documentTitle="Page not found">
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
