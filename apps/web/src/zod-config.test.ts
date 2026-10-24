import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #338 (audit G-24): Zod 4 probes for `new Function` when it builds its first object schema, and
 * the web front's CSP (`script-src 'self'`) reports that probe as a `securitypolicyviolation` on
 * every page load. `zod-config.ts` turns on `jitless` before any schema exists; these tests keep it
 * the first thing `main.tsx` imports and prove nothing on its import chain constructs a function.
 */
const mainSource = readFileSync(join(import.meta.dirname, 'main.tsx'), 'utf8');
/** The modules `main.tsx` imports, in source order. */
const mainImports = [...mainSource.matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map(
  (match) => match[1] ?? '',
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('zod-config', () => {
  it('is the first import of main.tsx', () => {
    expect(mainImports.length).toBeGreaterThan(1);
    expect(mainImports[0]).toBe('./zod-config.ts');
  });

  it("leaves Zod jitless and constructs no function on main's import chain", async () => {
    // Every `new Function(…)` and `Function(…)` from here on: Zod's probe is `new Function("")`.
    const constructed: unknown[][] = [];
    const RealFunction = Function;
    vi.stubGlobal(
      'Function',
      new Proxy(RealFunction, {
        construct(target, args: unknown[]) {
          constructed.push(args);
          return Reflect.construct(target, args) as object;
        },
        apply(target, self: unknown, args: unknown[]) {
          constructed.push(args);
          return Reflect.apply(target, self, args) as unknown;
        },
      }),
    );
    // main.tsx's own imports in its order (main itself mounts the app), then a parse that would
    // take Zod's compiled fast path if JIT were on.
    for (const specifier of mainImports) await import(/* @vite-ignore */ specifier);
    const { z } = await import('zod');
    const { clockSchema } = await import('@shopfloor/contracts/mes-api');
    expect(z.config().jitless).toBe(true);
    expect(z.object({ id: z.string(), n: z.number() }).parse({ id: 'a', n: 1 })).toEqual({
      id: 'a',
      n: 1,
    });
    expect(clockSchema.safeParse({}).success).toBe(false);
    expect(constructed).toEqual([]);
  });
});
