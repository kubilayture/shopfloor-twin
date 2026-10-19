import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { EdgeTrust, NO_EDGE, learnEdgeCidr, normaliseAddress } from './edge.ts';

const v4 = (address: string, cidr: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.0.0',
  family: 'IPv4',
  mac: '02:42:ac:14:00:03',
  internal,
  cidr,
});

/** A container on two networks: the default one and `edge` (#237). */
const INTERFACES = {
  lo: [v4('127.0.0.1', '127.0.0.1/8', true)],
  eth0: [v4('172.18.0.5', '172.18.0.5/16')],
  eth1: [v4('10.89.3.2', '10.89.3.2/24')],
};

describe('edge-network trust (#237)', () => {
  it('normalises IPv4-mapped IPv6 sources only', () => {
    expect(normaliseAddress('::ffff:10.89.3.7')).toBe('10.89.3.7');
    expect(normaliseAddress('::FFFF:10.89.3.7')).toBe('10.89.3.7');
    expect(normaliseAddress('10.89.3.7')).toBe('10.89.3.7');
    expect(normaliseAddress('::1')).toBe('::1');
    expect(normaliseAddress('::ffff:999.1.1.1')).toBe('::ffff:999.1.1.1');
    expect(normaliseAddress('fe80::ffff:10.0.0.1')).toBe('fe80::ffff:10.0.0.1');
  });

  it('learns the CIDR of the interface holding the alias address', async () => {
    const cidr = await learnEdgeCidr('mes-edge', {
      resolve: (name) => Promise.resolve(name === 'mes-edge' ? ['10.89.3.2'] : []),
      interfaces: () => INTERFACES,
    });
    expect(cidr).toBe('10.89.3.0/24');
    // An IPv4-mapped answer is the same address.
    expect(
      await learnEdgeCidr('mes-edge', {
        resolve: () => Promise.resolve(['::ffff:172.18.0.5']),
        interfaces: () => INTERFACES,
      }),
    ).toBe('172.18.0.0/16');
  });

  it('learns nothing when the alias does not resolve, or resolves to no local interface', async () => {
    const failing = await learnEdgeCidr('mes-edge', {
      resolve: () => Promise.reject(new Error('ENOTFOUND')),
      interfaces: () => INTERFACES,
    });
    expect(failing).toBeUndefined();
    // Another container's address (nginx's), or loopback: not this container's edge interface.
    for (const answer of [['10.89.3.9'], ['127.0.0.1'], []]) {
      expect(
        await learnEdgeCidr('mes-edge', {
          resolve: () => Promise.resolve(answer),
          interfaces: () => INTERFACES,
        }),
      ).toBeUndefined();
    }
  });

  it('trusts sources inside the CIDR only, mapped or not', () => {
    const trust = new EdgeTrust('10.89.3.0/24');
    expect(trust.trusts('10.89.3.7')).toBe(true);
    expect(trust.trusts('::ffff:10.89.3.7')).toBe(true);
    expect(trust.trusts('10.89.4.7')).toBe(false);
    expect(trust.trusts('::ffff:10.89.4.7')).toBe(false);
    expect(trust.trusts('172.18.0.9')).toBe(false);
    expect(trust.trusts('127.0.0.1')).toBe(false);
    expect(trust.trusts('::1')).toBe(false);
    expect(trust.trusts(undefined)).toBe(false);
    expect(trust.trusts('not an address')).toBe(false);
    expect(NO_EDGE.trusts('10.89.3.7')).toBe(false);
    expect(NO_EDGE.trusts('127.0.0.1')).toBe(false);
  });

  it('trusts an IPv6 edge network for IPv6 sources only', () => {
    const trust = new EdgeTrust('fd00:89:3::/64');
    expect(trust.trusts('fd00:89:3::7')).toBe(true);
    expect(trust.trusts('fd00:89:4::7')).toBe(false);
    expect(trust.trusts('10.89.3.7')).toBe(false);
  });

  it('refuses a malformed CIDR', () => {
    for (const cidr of ['10.89.3.0', '10.89.3.0/33', 'x/24', '10.89.3.0/-1', 'fd00::/129']) {
      expect(() => new EdgeTrust(cidr), cidr).toThrow(/not a CIDR/);
    }
  });
});
