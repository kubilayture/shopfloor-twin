/**
 * Exports the running stack's dev CA certificate (P9-14, ADR-0039) so the owner can trust it in a
 * browser or the system's trust store, and Node tools through NODE_EXTRA_CA_CERTS. The certificate
 * is public: the CA's key never leaves the `pki-ca` volume, which only the pki step mounts. It is
 * read from the web container (`/etc/nginx/tls/ca.pem`, written there by the pki step), checked
 * (a CA certificate, the issuer of the certificate nginx serves) and written to the file given, by
 * default `dev-ca.pem` in the repository (git-ignored). It prints the SHA-256 fingerprint to compare
 * when importing it, and how to trust it (runbook, "HTTPS and the dev CA").
 *
 * The stack is the one `docker compose` finds here (the dev stack, project `shopfloor-twin`); for
 * another set COMPOSE_PROJECT_NAME. A new dev CA (after `pnpm stack:reset` or `PKI_RENEW=dev-ca`)
 * must be exported and trusted again.
 *
 * Usage: pnpm stack:ca [file]
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] ?? resolve(REPO, 'dev-ca.pem'));

const read = (path: string): string => {
  try {
    return execFileSync('docker', ['compose', 'exec', '-T', 'web', 'cat', path], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    console.error(
      `stack:ca: could not read ${path} from the web container (is the stack up? pnpm stack:up)`,
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

const caPem = read('/etc/nginx/tls/ca.pem');
const ca = new X509Certificate(caPem);
const served = new X509Certificate(read('/etc/nginx/tls/server.pem'));
if (!ca.ca || !served.checkIssued(ca) || !served.verify(ca.publicKey)) {
  console.error(
    'stack:ca: ca.pem is not the CA that issued the web certificate: rerun the pki step',
  );
  process.exit(1);
}
writeFileSync(target, caPem, { mode: 0o644 });
console.log(`stack:ca: wrote ${target}`);
console.log(`  subject  ${ca.subject.replaceAll('\n', ', ')}`);
console.log(`  valid    until ${new Date(ca.validTo).toISOString()}`);
console.log(`  sha256   ${ca.fingerprint256}`);
console.log(
  'Trust it for TLS servers only (its name constraints cover TLS server names localhost and 127.0.0.1):',
);
console.log(
  `  macOS (Safari, Chrome):  security add-trusted-cert -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db ${target}`,
);
console.log(
  '  Firefox:                Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import',
);
console.log(`  Node.js tools:          NODE_EXTRA_CA_CERTS=${target} node …`);
console.log(`  curl:                   curl --cacert ${target} https://localhost:8443/healthz`);
console.log(
  '  Keychain Access instead: set only "Secure Sockets Layer (SSL)" to Always Trust, never "When using this certificate".',
);
console.log(
  'It can vouch for every *.localhost name on any port: remove the trust when you are not using the project.',
);
console.log('Then open https://localhost:8443');
