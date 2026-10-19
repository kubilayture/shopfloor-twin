/**
 * Checklist S1 against a running stack (#239): `docker compose run --rm opcua-tools` (the stack
 * smoke does), as the tools client with the `opcua-tools-pki` volume and `opcua-reader`.
 *
 * Environment: OPCUA_HOST (default `simulator`), OPCUA_PORT_OFFSET (default 0),
 * OPCUA_TOOLS_PKI_DIR (default `/var/lib/pki/tools`), OPCUA_READER_PASSWORD (required).
 * Exit 0 when every check passes, 1 naming the first that fails, 2 on a missing variable.
 */
import { SecurityCheckError, checkOpcuaSecurity } from './security-check.ts';

const readerPassword = process.env.OPCUA_READER_PASSWORD;
if (readerPassword === undefined || readerPassword === '') {
  console.error('FAIL: OPCUA_READER_PASSWORD must be set');
  process.exit(2);
}
try {
  await checkOpcuaSecurity({
    host: process.env.OPCUA_HOST ?? 'simulator',
    portOffset: Number(process.env.OPCUA_PORT_OFFSET ?? 0),
    toolsFolder: process.env.OPCUA_TOOLS_PKI_DIR ?? '/var/lib/pki/tools',
    readerPassword,
  });
  process.exit(0);
} catch (error) {
  console.error(
    error instanceof SecurityCheckError ? `FAIL: ${error.message}` : 'FAIL: OPC UA security check',
    error instanceof SecurityCheckError ? '' : error,
  );
  process.exit(1);
}
