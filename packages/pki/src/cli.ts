/**
 * The `pki` step (ADR-0038, ADR-0039): Compose's one-shot `pki` service runs it before the
 * simulator, the gateway and the web start. It makes or keeps every OPC UA key and certificate and
 * pins the peers, makes or keeps the dev CA and the web front's TLS certificate, then exits (0 on
 * success). Rerunning it prints every certificate's expiry and renews what expires within 30 days
 * (runbook, "OPC UA certificates" and "HTTPS and the dev CA").
 *
 * Environment: PKI_SIMULATOR_DIR, PKI_GATEWAY_DIR, PKI_TOOLS_DIR (the three OPC UA volumes),
 * PKI_CA_DIR (the dev CA's volume, `pki-ca`), PKI_WEB_DIR (nginx's, `web-tls`), optional
 * PKI_WEB_KEY_GID (nginx's group: the web key is then 0640 with it), PKI_VALIDITY_DAYS (default
 * 365) and PKI_RENEW (comma-separated identities to renew now, `dev-ca` and `web` among them; an
 * unknown name exits 2). Whenever it renews a certificate or changes a trust folder it prints a line
 * asking to restart what reads them only when it starts.
 * Usage: node packages/pki/src/cli.ts
 */
import { resolve } from 'node:path';
import { DEFAULT_VALIDITY_DAYS, UnknownIdentityError, ensureOpcuaPki } from './exchange.ts';
import { TLS_IDENTITIES, WEB_VALIDITY_DAYS, ensureWebTls } from './tls.ts';

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
const isTls = (name: string) => (TLS_IDENTITIES as readonly string[]).includes(name);
const keyGroupText = process.env.PKI_WEB_KEY_GID?.trim() ?? '';
if (keyGroupText !== '' && !/^\d{1,9}$/.test(keyGroupText)) {
  console.error('pki: PKI_WEB_KEY_GID must be a numeric group id');
  process.exit(2);
}

try {
  const result = await ensureOpcuaPki({
    simulator: required('PKI_SIMULATOR_DIR'),
    gateway: required('PKI_GATEWAY_DIR'),
    tools: required('PKI_TOOLS_DIR'),
    validityDays: validity,
    renew: renew.filter((name) => !isTls(name)),
  });
  const tls = await ensureWebTls({
    ca: required('PKI_CA_DIR'),
    web: required('PKI_WEB_DIR'),
    validityDays: Math.min(validity, WEB_VALIDITY_DAYS),
    renew: renew.filter(isTls),
    ...(keyGroupText === '' ? {} : { keyGroup: Number(keyGroupText) }),
  });
  for (const identity of [...result.identities, ...tls.identities]) {
    console.log(
      `pki: ${identity.name.padEnd(12)} ${identity.action.padEnd(7)} until ${identity.notAfter.toISOString()}` +
        `  sha1 ${identity.thumbprint}${identity.reason ? `  (${identity.reason})` : ''}`,
    );
  }
  for (const entry of result.removed) console.log(`pki: removed ${entry}`);
  console.log(`pki: dev CA sha256 ${tls.caFingerprint}`);
  console.log(`pki: web spki sha256 ${tls.webSpki}`);
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
  const [devCa, web] = tls.identities;
  if (devCa?.action === 'renewed') {
    console.log(
      'pki: !!! RENEWED the dev CA: trust the new one (pnpm stack:ca, runbook "HTTPS and the dev CA") !!!',
    );
  }
  if (web?.action === 'renewed') {
    // nginx reads its certificate when it starts.
    console.log(
      'pki: !!! RENEWED the web certificate: RESTART THE WEB (docker compose restart web) !!!',
    );
  }
  console.log(
    `pki: ok, ${String(made)} of ${String(result.identities.length)} OPC UA certificates made, ` +
      `${String(result.pinned)} pins, ${String(Math.round(result.elapsedMs))} ms; ` +
      `dev CA ${devCa?.action ?? '?'}, web ${web?.action ?? '?'}, ${String(Math.round(tls.elapsedMs))} ms`,
  );
} catch (error) {
  console.error(`pki: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof UnknownIdentityError ? 2 : 1);
}
