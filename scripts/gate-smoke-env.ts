/**
 * The environment the gate gives the stack smoke and its own Compose calls (#277 review B1). The
 * smoke keeps `COMPOSE_PROJECT_NAME` and `IMAGE_TAG` from its environment over its env file's (as
 * Compose does), so the gate passes its disposable project and tag explicitly: a stray
 * `COMPOSE_PROJECT_NAME=shopfloor-twin` or `IMAGE_TAG=dev` exported in the shell that runs
 * `pnpm gate` can never point the smoke at the dev stack. Tested by e2e/src/fresh-clone-checks.test.ts.
 */
export function gateSmokeEnv(
  envFile: string,
  project: string,
  tag: string,
): Record<string, string> {
  return {
    ...gateComposeEnv(project, tag),
    SMOKE_ENV_FILE: envFile,
    SMOKE_WRITES: '1',
    SMOKE_EPHEMERAL_PORTS: '1',
  };
}

/** The project and the tag for every Compose call of the gate's own. */
export function gateComposeEnv(project: string, tag: string): Record<string, string> {
  return { COMPOSE_PROJECT_NAME: project, IMAGE_TAG: tag };
}
