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
