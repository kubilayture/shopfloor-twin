/**
 * Zod's global configuration, set before any schema exists (#338, audit G-24). Imported for its
 * side effect as the very first import of `main.tsx`: Zod 4 decides whether to compile object
 * parsers with `new Function` when a schema is built, which happens while `@shopfloor/contracts`
 * is imported, and its first object schema runs a cached probe, `new Function("")`. Under the web
 * front's CSP (`script-src 'self'`, no `'unsafe-eval'`) that probe throws, Zod catches it and falls
 * back to the interpreter, but the browser still reports a `securitypolicyviolation` on every page
 * load. `jitless` skips the probe and the compiled parsers; parsing results are unchanged.
 */
import { z } from 'zod';

z.config({ jitless: true });
