import { BlockList, isIP } from 'node:net';

export type ForwardedHeader = 'x-forwarded-for' | 'cf-connecting-ip';

export interface ProxyTrust {
  readonly proxies: BlockList;
  readonly header: ForwardedHeader;
}

/** Dual-stack sockets report IPv4 peers as `::ffff:a.b.c.d`; compare them as IPv4. */
function normalize(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1] ?? address;
}

function isTrusted(proxies: BlockList, address: string): boolean {
  const family = isIP(address);
  return family !== 0 && proxies.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Parses comma-separated IPs and CIDRs (`10.0.0.0/8`, `::1`). Returns undefined when an entry is
 * invalid, so a typo never silently trusts nothing or everything.
 */
export function parseTrustedProxies(value: string): BlockList | undefined {
  const proxies = new BlockList();
  for (const entry of value.split(',').map((part) => part.trim())) {
    if (entry === '') continue;
    const [address = '', prefix, ...rest] = entry.split('/');
    const family = isIP(address);
    if (family === 0 || rest.length > 0) return undefined;
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      proxies.addAddress(address, type);
      continue;
    }
    const bits = Number(prefix);
    if (!/^\d+$/.test(prefix) || bits > (family === 4 ? 32 : 128)) return undefined;
    proxies.addSubnet(address, bits, type);
  }
  return proxies;
}

/**
 * The client IP (spec §8.1): the TCP peer, unless the peer is a trusted proxy. Then
 * `X-Forwarded-For` is read right to left, skipping trusted hops, and the first untrusted entry is
 * the client; `CF-Connecting-IP` is taken as is. A malformed value stops at the last trusted hop.
 */
export function clientIp(
  peer: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  trust: ProxyTrust,
): string {
  let client = normalize(peer);
  if (!isTrusted(trust.proxies, client)) return client;
  const raw = headers[trust.header];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (value === undefined) return client;
  const hops = value.split(',').map((hop) => normalize(hop.trim()));
  if (trust.header === 'cf-connecting-ip') {
    const [only] = hops;
    return hops.length === 1 && only !== undefined && isIP(only) !== 0 ? only : client;
  }
  for (const hop of hops.reverse()) {
    if (isIP(hop) === 0) return client;
    client = hop;
    if (!isTrusted(trust.proxies, hop)) return client;
  }
  return client;
}

/** The 16-bit groups of an IPv6 address, an embedded IPv4 address included. */
function groups(address: string): number[] {
  const parse = (part: string) =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head = '', tail] = address.split('::');
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * What per-IP limits count by (ADR 0011): an IPv4 address as is, and an IPv6 one by its first
 * `prefixLength` bits, as `2001:db8:0:1:0:0:0:0/64`. A host is given a whole /64, so counting
 * each address would let it pass every per-IP limit.
 */
export function ipKey(ip: string, prefixLength: number): string {
  if (prefixLength >= 128 || isIP(ip) !== 6) return ip;
  // A zone (`fe80::1%eth0`) ends the last group, which a prefix below 128 masks out.
  const masked = groups(ip).map((group, index) => {
    const bits = Math.min(16, Math.max(0, prefixLength - index * 16));
    return group & ((0xffff << (16 - bits)) & 0xffff);
  });
  return `${masked.map((group) => group.toString(16)).join(':')}/${prefixLength}`;
}
