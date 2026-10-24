/**
 * The in-page index of a long detail page (UX-1e, #317; design system 3.4: order, shift report,
 * serial, lot, SPC chart): a row of anchor links to the page's sections under the header, sticky
 * from `xl`. Each section keeps its own id and test id; the links only point at them. Plain
 * `#id` links: the browser scrolls (`scroll-padding-top` keeps the heading clear of the bars) and
 * the history records the jump.
 */
export interface SectionNavItem {
  /** The section element's id. */
  readonly id: string;
  readonly label: string;
}

export interface SectionNavProps {
  readonly items: readonly SectionNavItem[];
  /** The landmark's name; "On this page" by default. */
  readonly label?: string;
  readonly testId?: string | undefined;
}

export function SectionNav({ items, label = 'On this page', testId }: SectionNavProps) {
  return (
    <nav
      aria-label={label}
      data-testid={testId}
      className="border-b border-line bg-canvas py-2 xl:sticky xl:top-12 xl:z-sticky print:hidden"
    >
      <ul className="flex flex-wrap gap-x-1 gap-y-1 text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="inline-flex min-h-6 items-center rounded-md px-2 text-link underline-offset-4 hover:bg-surface-hover hover:underline"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
