import { existsSync, readFileSync } from 'node:fs';
import { inspectCertificate, keyMatchesCertificate } from './certificate.ts';
import { pkiFiles, type PkiFiles } from './layout.ts';

/**
 * The material a component needs before it may open or accept a secure OPC UA session (ADR-0038):
 * its certificate and key, made by the `pki` step, the certificate naming `applicationUri` first in
 * its SAN. Throws, naming the file, instead of letting node-opcua make a certificate of its own.
 */
export function requireOwnMaterial(root: string, applicationUri: string): PkiFiles {
  const files = pkiFiles(root);
  for (const file of [files.certificateFile, files.privateKeyFile]) {
    if (!existsSync(file)) {
      throw new Error(`${file} is missing: run the pki step first (docker compose run --rm pki)`);
    }
  }
  const pem = readFileSync(files.certificateFile, 'utf8');
  const info = inspectCertificate(pem);
  if (info.uris[0] !== applicationUri) {
    throw new Error(
      `${files.certificateFile} is for ${String(info.uris[0])}, not ${applicationUri}: run the pki step again`,
    );
  }
  if (!keyMatchesCertificate(readFileSync(files.privateKeyFile, 'utf8'), pem)) {
    throw new Error(`${files.privateKeyFile} is not the key of ${files.certificateFile}`);
  }
  if (info.notAfter.getTime() <= Date.now()) {
    throw new Error(
      `${files.certificateFile} expired ${info.notAfter.toISOString()}: run the pki step again`,
    );
  }
  return files;
}
