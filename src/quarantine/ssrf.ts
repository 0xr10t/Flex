// Implements: §8.2 step 3 "Refuse hosts that resolve to private, loopback or link-local ranges (127.0.0.0/8,
// 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7, fe80::/10)", §16.4 outbound limits.
// IPv4-mapped IPv6 addresses are checked as their IPv4 address. 0.0.0.0/8 ("this host") is also refused
// (spec-questions/B.md SQB-12).
// Owner: Lane B.

import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addAddress('::1', 'ipv6');
blocked.addAddress('::', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');

function mappedV4(ip: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when `ip` (a literal IPv4/IPv6 address) is in a refused range. Non-IP strings are refused too. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = mappedV4(bare);
  if (v4 !== null) return blocked.check(v4, 'ipv4');
  const fam = isIP(bare);
  if (fam === 4) return blocked.check(bare, 'ipv4');
  if (fam === 6) return blocked.check(bare, 'ipv6');
  return true;
}
