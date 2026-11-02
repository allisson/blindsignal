const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks the signaling URL: `wss://`, or `ws://` only on a loopback host for local development
 * (spec §16). The access token never goes in it.
 */
export function signalingUrl(serverUrl: string | URL): URL {
  const url = new URL(serverUrl);
  if (url.protocol === 'wss:' || (url.protocol === 'ws:' && LOOPBACK.has(url.hostname))) {
    return url;
  }
  throw new TypeError('serverUrl must use wss://, or ws:// on a loopback host');
}
