const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks the signaling URL: `wss://`, or `ws://` only on a loopback host for local development
 * (spec §16). The access token never goes in it.
 */
export function signalingUrl(serverUrl: string | URL): URL {
  const url = new URL(serverUrl);
  // Nothing secret belongs in it: the URL reaches logs and proxies, and the token goes in auth.
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('serverUrl takes no userinfo, query, or fragment');
  }
  if (url.protocol === 'wss:' || (url.protocol === 'ws:' && LOOPBACK.has(url.hostname))) {
    return url;
  }
  throw new TypeError('serverUrl must use wss://, or ws:// on a loopback host');
}
