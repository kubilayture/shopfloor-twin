/**
 * The secrets the stack requires (Compose `:?`) plus the bootstrap admin's: the gate appends each
 * to its throw-away env file when `.env.example` lacks it (`scripts/gate.ts`), and
 * `scripts/stack-init.sh` generates, appends and checks the same list (`REQUIRED_SECRETS` there;
 * #277, asserted equal by e2e/src/stack-init.test.ts).
 */
export const REQUIRED_SECRETS: readonly string[] = [
  'DB_PASSWORD',
  'DB_APP_PASSWORD',
  'MQTT_HEALTHCHECK_PASSWORD',
  'MQTT_DEV_PASSWORD',
  'MQTT_GATEWAY_PASSWORD',
  'MQTT_MES_PASSWORD',
  'ERP_API_TOKEN',
  'SIM_CONTROL_TOKEN',
  'OPCUA_GATEWAY_PASSWORD',
  'OPCUA_READER_PASSWORD',
  'MES_BOOTSTRAP_ADMIN_PASSWORD',
];

/** The rule both use for the values they generate: every `*_PASSWORD` and `*_TOKEN` key. */
export const GENERATED_KEY = /_(PASSWORD|TOKEN)$/;

/**
 * The lines of an env file made from `.env.example`'s text: every `*_PASSWORD` and `*_TOKEN` key
 * given `secret()`, every other line kept, then each required secret the example lacks appended.
 * The gate's throw-away env file is these lines plus its project and tag; `scripts/stack-init.sh`
 * writes the same keys (asserted by e2e/src/stack-init.test.ts).
 */
export function envFromExample(example: string, secret: () => string): string[] {
  const seen = new Set<string>();
  const lines = example.split('\n').map((line) => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (key === undefined) return line;
    seen.add(key);
    return GENERATED_KEY.test(key) ? `${key}=${secret()}` : line;
  });
  for (const key of REQUIRED_SECRETS) if (!seen.has(key)) lines.push(`${key}=${secret()}`);
  return lines;
}
