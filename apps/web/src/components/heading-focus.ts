import { useEffect, useRef, type RefObject } from 'react';

let pending = false;

/** Asks the next screen heading that mounts to take focus (set when the route changes). */
export function requestHeadingFocus(): void {
  pending = true;
}

/**
 * A screen's main heading: focused when it mounts after a navigation, so keyboard and screen
 * reader users start at the new content. Not on the first load. Screens that show their heading
 * only once data has loaded take focus then.
 */
export function useHeadingFocus<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (pending && ref.current) {
      pending = false;
      ref.current.focus();
    }
  }, []);
  return ref;
}
