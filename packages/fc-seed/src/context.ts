/** The value `global-setup.ts` provides to the workers. */
declare module 'vitest' {
  export interface ProvidedContext {
    /** The run's fast-check seed. */
    fcSeed: number;
  }
}

export {};
