import { describe, expect, it } from 'vitest';
import { clientIp, ipKey, parseTrustedProxies, type ForwardedHeader } from './client-ip.ts';

function trust(proxies: string, header: ForwardedHeader = 'x-forwarded-for') {
  const parsed = parseTrustedProxies(proxies);
  if (parsed === undefined) throw new Error(`invalid proxies: ${proxies}`);
  return { proxies: parsed, header };
}

describe('parseTrustedProxies', () => {
  it('accepts IPs and CIDRs of both families, ignoring blanks', () => {
    const proxies = parseTrustedProxies(' 10.0.0.0/8 ,, 192.168.1.1, fd00::/8, ::1 ');
    expect(proxies?.check('10.255.0.1', 'ipv4')).toBe(true);
    expect(proxies?.check('192.168.1.1', 'ipv4')).toBe(true);
    expect(proxies?.check('192.168.1.2', 'ipv4')).toBe(false);
    expect(proxies?.check('fd12::1', 'ipv6')).toBe(true);
    expect(proxies?.check('::1', 'ipv6')).toBe(true);
  });

  it('trusts nothing when empty', () => {
    expect(parseTrustedProxies('')?.rules).toEqual([]);
  });

  it.each([
    'proxy.internal',
    '10.0.0.0/33',
    '::/129',
    '10.0.0.0/',
    '10.0.0.0/8/8',
    '10.0.0.0/-1',
    '10.0.0.0/x',
  ])('rejects %s', (entry) => {
    expect(parseTrustedProxies(`127.0.0.1, ${entry}`)).toBeUndefined();
  });
});

describe('clientIp', () => {
  const proxies = trust('10.0.0.0/8');

  it('uses the TCP peer when there is no forwarding header', () => {
    expect(clientIp('10.0.0.1', {}, proxies)).toBe('10.0.0.1');
  });

  it('ignores forwarding headers from an untrusted peer', () => {
    const headers = { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '1.2.3.4' };
    expect(clientIp('203.0.113.9', headers, proxies)).toBe('203.0.113.9');
    expect(clientIp('203.0.113.9', headers, trust('10.0.0.0/8', 'cf-connecting-ip'))).toBe(
      '203.0.113.9',
    );
  });

  it('trusts nothing by default', () => {
    expect(clientIp('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }, trust(''))).toBe('127.0.0.1');
  });

  it('reads X-Forwarded-For right to left, skipping trusted hops', () => {
    const headers = { 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.0.0.5' };
    expect(clientIp('10.0.0.1', headers, proxies)).toBe('198.51.100.7');
  });

  it('joins repeated X-Forwarded-For headers', () => {
    const headers = { 'x-forwarded-for': ['6.6.6.6', '198.51.100.7, 10.0.0.5'] };
    expect(clientIp('10.0.0.1', headers, proxies)).toBe('198.51.100.7');
  });

  it('takes the leftmost hop when every hop is trusted', () => {
    const headers = { 'x-forwarded-for': '10.0.0.9, 10.0.0.5' };
    expect(clientIp('10.0.0.1', headers, proxies)).toBe('10.0.0.9');
  });

  it('stops at the last trusted hop on a malformed entry', () => {
    expect(clientIp('10.0.0.1', { 'x-forwarded-for': 'garbage' }, proxies)).toBe('10.0.0.1');
    const headers = { 'x-forwarded-for': '1.2.3.4, unknown, 10.0.0.5' };
    expect(clientIp('10.0.0.1', headers, proxies)).toBe('10.0.0.5');
  });

  it('compares IPv4-mapped IPv6 addresses as IPv4', () => {
    const headers = { 'x-forwarded-for': '::ffff:198.51.100.7' };
    expect(clientIp('::ffff:10.0.0.1', headers, proxies)).toBe('198.51.100.7');
    expect(clientIp('::FFFF:203.0.113.9', headers, proxies)).toBe('203.0.113.9');
  });

  it('handles IPv6 proxies and clients', () => {
    const headers = { 'x-forwarded-for': '2001:db8::1' };
    expect(clientIp('fd00::1', headers, trust('fd00::/8'))).toBe('2001:db8::1');
  });

  describe('CF-Connecting-IP', () => {
    const cloudflare = trust('10.0.0.0/8', 'cf-connecting-ip');

    it('takes the header from a trusted peer', () => {
      const headers = { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '6.6.6.6' };
      expect(clientIp('10.0.0.1', headers, cloudflare)).toBe('198.51.100.7');
    });

    it.each(['garbage', '1.2.3.4, 5.6.7.8', ''])('falls back to the peer on %j', (value) => {
      expect(clientIp('10.0.0.1', { 'cf-connecting-ip': value }, cloudflare)).toBe('10.0.0.1');
    });

    it('falls back to the peer without the header', () => {
      const headers = { 'x-forwarded-for': '6.6.6.6' };
      expect(clientIp('10.0.0.1', headers, cloudflare)).toBe('10.0.0.1');
    });
  });
});

describe('ipKey', () => {
  it.each([
    ['203.0.113.7', 64, '203.0.113.7'],
    ['2001:db8:0:1:2:3:4:5', 64, '2001:db8:0:1:0:0:0:0/64'],
    ['2001:db8:0:1::5', 64, '2001:db8:0:1:0:0:0:0/64'],
    ['::1', 64, '0:0:0:0:0:0:0:0/64'],
    ['2001:db8::', 64, '2001:db8:0:0:0:0:0:0/64'],
    ['2001:db8:abcd:12ff::1', 56, '2001:db8:abcd:1200:0:0:0:0/56'],
    ['2001:db8:abcd:12ff::1', 1, '0:0:0:0:0:0:0:0/1'],
    ['ffff:db8::1', 1, '8000:0:0:0:0:0:0:0/1'],
    ['2001:db8:0:1:2:3:4:5', 112, '2001:db8:0:1:2:3:4:0/112'],
    ['64:ff9b::198.51.100.255', 120, '64:ff9b:0:0:0:0:c633:6400/120'],
    ['fe80::1%eth0', 64, 'fe80:0:0:0:0:0:0:0/64'],
    ['2001:db8::5', 128, '2001:db8::5'],
    // No peer address: the socket is already gone.
    ['', 64, ''],
  ])('keys %s by /%i as %s', (ip, prefix, key) => {
    expect(ipKey(ip, prefix)).toBe(key);
  });
});
