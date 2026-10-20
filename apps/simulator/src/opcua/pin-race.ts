import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureOpcuaPki, opcuaIdentities, pkiFiles, type PkiRoots } from '@shopfloor/pki';
import { OPCUACertificateManager } from 'node-opcua';

/**
 * The regression check of #265: the `pki` step rerun while node-opcua certificate managers watch
 * every identity's folder, as a later `docker compose up` reruns it against the running simulator
 * and gateway. node-opcua-pki 7.1.0's watcher (chokidar, `atomic`) could index the step's temp file
 * `<peer>.pem.<pid>.tmp` in `trusted/certs`; its delayed `unlink` then deleted the fingerprint the
 * real pin shares, and the pin stayed untrusted until a restart. The race shows on Linux (inotify)
 * only: the stack smoke runs this in the simulator image (`opcua-tools`, `pin-race-cli.ts`); on
 * macOS the unit test runs it too but can't fail for this reason.
 *
 * - every manager starts on the step's first run and must trust every pin of its identity;
 * - `reruns` unchanged reruns, each holding every staged file back for one of `delaysMs` before
 *   its rename (the old code staged and renamed every pin on every run);
 * - `renewals` reruns that renew one identity (tools, a server, the gateway in turn) with the same
 *   delays: the renewed certificate's new pins must be trusted by the running managers. This runs
 *   the step in this process, beside the managers; it does NOT show that a renewal made by another
 *   process (Compose's `pki` container) is picked up: in the review of PR #267, 9 cross-process
 *   renewals on Linux lost 15 pin checks and left 3 superseded certificates trusted. A renewal is
 *   guaranteed only after restarting the simulator and the gateway (runbook, ADR-0038).
 *
 * After each run it waits `settleMs` (chokidar's `atomic` holds an unlink back 100 ms) and asks
 * every manager whether it trusts each current pin.
 */
export interface PinRaceOptions {
  readonly reruns?: number;
  readonly renewals?: number;
  readonly delaysMs?: readonly number[];
  readonly settleMs?: number;
  readonly log?: (line: string) => void;
}

export interface PinRaceResult {
  readonly runs: number;
  /** `<run>: <identity> lost <peer> (<status>)`, empty when trust survived every run. */
  readonly lost: readonly string[];
}

const DEFAULT_DELAYS_MS = [0, 1, 5, 10, 20] as const;

const der = (pem: string): Buffer => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function checkPinRace(options: PinRaceOptions = {}): Promise<PinRaceResult> {
  const reruns = options.reruns ?? 10;
  const renewals = options.renewals ?? 6;
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
  const settleMs = options.settleMs ?? 500;
  const log = options.log ?? (() => undefined);
  const root = await mkdtemp(join(tmpdir(), 'shopfloor-twin-pin-race-'));
  const roots: PkiRoots = {
    simulator: join(root, 'simulator'),
    gateway: join(root, 'gateway'),
    tools: join(root, 'tools'),
  };
  const identities = opcuaIdentities(roots);
  const managers = new Map<string, OPCUACertificateManager>();
  const lost: string[] = [];
  let runs = 0;
  try {
    await ensureOpcuaPki(roots);
    runs++;
    for (const identity of identities) {
      const manager = new OPCUACertificateManager({
        rootFolder: identity.folder,
        automaticallyAcceptUnknownCertificate: false,
      });
      await manager.initialize();
      managers.set(identity.name, manager);
    }
    // The watchers start after initialize() and report `ready` later.
    await sleep(Math.max(settleMs, 1000));
    const check = async (run: string) => {
      const before = lost.length;
      for (const identity of identities) {
        const manager = managers.get(identity.name);
        for (const peer of identity.pins) {
          const pem = await readFile(
            join(pkiFiles(identity.folder).trustedCerts, `${peer}.pem`),
            'utf8',
          );
          const status = await manager?.isCertificateTrusted(der(pem));
          if (status !== 'Good')
            lost.push(`${run}: ${identity.name} lost ${peer} (${String(status)})`);
        }
      }
      log(`${lost.length === before ? 'ok' : 'LOST'}: ${run}`);
    };
    await check('first run');
    const renewed = ['tools', identities[0]?.name ?? 'tools', 'edge-gateway'];
    for (let i = 0; i < reruns + renewals; i++) {
      const delay = delays[i % delays.length] ?? 0;
      const renew = i < reruns ? [] : [renewed[(i - reruns) % renewed.length] ?? 'tools'];
      const result = await ensureOpcuaPki({
        ...roots,
        renew,
        onStaged: () => sleep(delay),
      });
      runs++;
      await sleep(settleMs);
      await check(
        `run ${String(runs)} (${renew.length > 0 ? `renew ${renew.join(', ')}` : 'unchanged'}, ` +
          `${String(delay)} ms before rename, ${String(result.written)} pins written)`,
      );
    }
  } finally {
    for (const manager of managers.values()) await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
  return { runs, lost };
}
