/**
 * Edge-network trust (#237, Phase 9 plan "Login throttling", ADR-0026 amendment): which proxied
 * requests come from nginx over the internal `edge` network, the only connections whose
 * `X-Original-Method` (and, from P9-15, `X-Real-IP`) the MES believes.
 *
 * The subnet is not pinned in Compose (a fixed one would make parallel projects fail with "Pool
 * overlaps"), so the MES learns it at start: it resolves its own alias on `edge`
 * (`MES_EDGE_ALIAS`, default `mes-edge`, an alias that exists only there) to its address on that
 * network, finds the local interface holding that address (`os.networkInterfaces()`, which
 * carries the CIDR) and trusts sources inside that CIDR, after normalising an IPv4-mapped IPv6
 * source (`::ffff:a.b.c.d`) to its IPv4 form. `internal: true` gives the network no gateway, so
 * only its two attached containers (nginx and the MES) reach each other there.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** `::ffff:10.1.2.3` (an IPv4 client on a dual-stack socket) → `10.1.2.3`; others unchanged. */
export function normaliseAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] !== undefined && isIPv4(mapped[1]) ? mapped[1] : address;
}

/** Who may send trusted proxy headers: sources inside the learned `edge` CIDR, or nobody. */
export class EdgeTrust {
  /** The learned CIDR (`172.20.0.0/16`), or undefined: nothing is trusted. */
  readonly cidr: string | undefined;
  readonly #list: BlockList | undefined;
  readonly #family: 'ipv4' | 'ipv6' | undefined;

  constructor(cidr: string | undefined) {
    this.cidr = cidr;
    if (cidr === undefined) return;
    const [network = '', prefix = ''] = cidr.split('/');
    const family = isIPv4(network) ? 'ipv4' : isIPv6(network) ? 'ipv6' : undefined;
    const bits = Number(prefix);
    if (
      family === undefined ||
      !/^\d{1,3}$/.test(prefix) ||
      bits < 0 ||
      bits > (family === 'ipv4' ? 32 : 128)
    ) {
      throw new Error(`not a CIDR: ${cidr}`);
    }
    this.#family = family;
    this.#list = new BlockList();
    this.#list.addSubnet(network, bits, family);
  }

  /** Whether a connection from this source address (as the socket reports it) is trusted. */
  trusts(address: string | undefined): boolean {
    if (address === undefined || this.#list === undefined || this.#family === undefined) {
      return false;
    }
    const source = normaliseAddress(address);
    const family = isIPv4(source) ? 'ipv4' : isIPv6(source) ? 'ipv6' : undefined;
    // An IPv6 source never matches an IPv4 network, nor the other way round.
    if (family !== this.#family) return false;
    return this.#list.check(source, family);
  }
}

/** Nothing trusted: tests and runs outside Compose without an `edge` network. */
export const NO_EDGE = new EdgeTrust(undefined);

export interface EdgeLookup {
  /** Every address the name resolves to (default: `dns.lookup(name, { all: true })`). */
  readonly resolve?: (name: string) => Promise<readonly string[]>;
  /** The local interfaces (default: `os.networkInterfaces()`). */
  readonly interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

/**
 * The CIDR of the local interface that holds an address the alias resolves to, or undefined when
 * the alias doesn't resolve, or resolves to no local address (another container's, or a name
 * outside Compose). Never throws.
 */
export async function learnEdgeCidr(
  alias: string,
  {
    resolve = async (name) => (await dnsLookup(name, { all: true })).map((a) => a.address),
    interfaces = networkInterfaces,
  }: EdgeLookup = {},
): Promise<string | undefined> {
  let addresses: readonly string[];
  try {
    addresses = (await resolve(alias)).map(normaliseAddress);
  } catch {
    return undefined;
  }
  for (const infos of Object.values(interfaces())) {
    for (const info of infos ?? []) {
      if (info.internal || info.cidr === null) continue;
      if (addresses.includes(normaliseAddress(info.address))) {
        // `cidr` is the interface's address with its prefix (`172.20.0.3/16`): its network.
        const [, prefix = ''] = info.cidr.split('/');
        const network = networkOf(info.address, Number(prefix), info.family === 'IPv4');
        return network === undefined ? undefined : `${network}/${prefix}`;
      }
    }
  }
  return undefined;
}

/** The network address of an IPv4 address and prefix (`172.20.0.3`, 16 → `172.20.0.0`). */
function networkOf(address: string, prefix: number, ipv4: boolean): string | undefined {
  if (!ipv4) {
    // An IPv6 CIDR: BlockList masks the host bits itself, so the address can stand for it.
    return isIPv6(address) ? address : undefined;
  }
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || prefix < 0 || prefix > 32) return undefined;
  const value = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (value & mask) >>> 0;
  return [24, 16, 8, 0].map((shift) => String((network >>> shift) & 255)).join('.');
}
