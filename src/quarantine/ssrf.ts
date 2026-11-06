// Implements: §8.2 step 3 "Refuse hosts that resolve to private, loopback or link-local ranges (127.0.0.0/8,
// 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7, fe80::/10)", §16.4 outbound limits.
// 0.0.0.0/8 ("this host") and :: are also refused (spec-questions/B.md SQB-12). SQ-O-08 / F-13 (human, 2026-11-06)
// add 100.64.0.0/10, 192.0.0.0/24, 198.18.0.0/15, 224.0.0.0/4, 255.255.255.255, ff00::/8, fec0::/10, and refuse
// 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) entirely. IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
// addresses are decoded and checked as their IPv4 address. The same check runs before the request and at connect
// time (fetch.ts `pinnedLookup`).
// Owner: Lane B.

import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addSubnet('100.64.0.0', 10, 'ipv4');
blocked.addSubnet('192.0.0.0', 24, 'ipv4');
blocked.addSubnet('198.18.0.0', 15, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addAddress('255.255.255.255', 'ipv4');
blocked.addAddress('::1', 'ipv6');
blocked.addAddress('::', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('fec0::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');
blocked.addSubnet('64:ff9b::', 96, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');

/** The eight 16-bit groups of a valid IPv6 literal (a trailing dotted quad becomes the last two groups). */
function ipv6Groups(ip: string): number[] {
  let s = ip.toLowerCase();
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (quad !== null) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = s.split('::');
  const part = (p: string): number[] => (p === '' ? [] : p.split(':').map((g) => parseInt(g, 16)));
  const h = part(head);
  const t = tail === undefined ? [] : part(tail);
  return [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

/** IPv4 address embedded as IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96), else null. */
function embeddedV4(ip: string): string | null {
  const g = ipv6Groups(ip);
  const zeros = g.slice(0, 5).every((x) => x === 0);
  if (!zeros || (g[5] !== 0 && g[5] !== 0xffff)) return null;
  const hi = g[6] ?? 0;
  const lo = g[7] ?? 0;
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True when `ip` (a literal IPv4/IPv6 address) is in a refused range. Non-IP strings are refused too. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const fam = isIP(bare);
  if (fam === 4) return blocked.check(bare, 'ipv4');
  if (fam !== 6) return true;
  const v4 = embeddedV4(bare);
  if (v4 !== null) return blocked.check(v4, 'ipv4');
  return blocked.check(bare, 'ipv6');
}
