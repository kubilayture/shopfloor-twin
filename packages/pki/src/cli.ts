/**
 * The `pki` step (ADR-0038): Compose's one-shot `pki` service runs it before the simulator and the
 * gateway start. It makes or keeps every OPC UA key and certificate and pins the peers, then exits
 * (0 on success). Rerunning it prints every certificate's expiry and renews what expires within 30
 * days (runbook, "OPC UA certificates").
 *
 * Environment: PKI_SIMULATOR_DIR, PKI_GATEWAY_DIR, PKI_TOOLS_DIR (the three volumes), optional
 * PKI_VALIDITY_DAYS (default 365) and PKI_RENEW (comma-separated identities to renew now; an
 * unknown name exits 2). Whenever it renews a certificate or changes a trust folder it prints a
 * line asking to restart the simulator and the gateway, which read both only when they start.
 * Usage: node packages/pki/src/cli.ts
 */
import { resolve } from 'node:path';
import { DEFAULT_VALIDITY_DAYS, UnknownIdentityError, ensureOpcuaPki } from './exchange.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    console.error(`pki: ${name} must be set`);
    process.exit(2);
  }
  return resolve(value);
}

const validity = Number(process.env.PKI_VALIDITY_DAYS ?? DEFAULT_VALIDITY_DAYS);
const renew = (process.env.PKI_RENEW ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');

try {
  const result = await ensureOpcuaPki({
    simulator: required('PKI_SIMULATOR_DIR'),
    gateway: required('PKI_GATEWAY_DIR'),
    tools: required('PKI_TOOLS_DIR'),
    validityDays: validity,
    renew,
  });
  for (const identity of result.identities) {
    console.log(
      `pki: ${identity.name.padEnd(12)} ${identity.action.padEnd(7)} until ${identity.notAfter.toISOString()}` +
        `  sha1 ${identity.thumbprint}${identity.reason ? `  (${identity.reason})` : ''}`,
    );
  }
  for (const entry of result.removed) console.log(`pki: removed ${entry}`);
  const made = result.identities.filter((identity) => identity.action !== 'kept').length;
  const renewed = result.identities.filter((identity) => identity.action === 'renewed');
  if (renewed.length > 0 || result.removed.length > 0) {
    // node-opcua reads its own certificate and the pins when it starts: a running simulator or
    // gateway keeps the old ones until it restarts.
    console.log(
      `pki: !!! RENEWED ${renewed.map((identity) => identity.name).join(', ') || 'no certificate'}; ` +
        `trust changed in ${String(result.removed.length)} place(s): RESTART THE SIMULATOR AND THE GATEWAY ` +
        '(docker compose restart simulator gateway) !!!',
    );
  }
  console.log(
    `pki: ok, ${String(made)} of ${String(result.identities.length)} OPC UA certificates made, ` +
      `${String(result.pinned)} pins, ${String(Math.round(result.elapsedMs))} ms`,
  );
} catch (error) {
  console.error(`pki: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof UnknownIdentityError ? 2 : 1);
}
