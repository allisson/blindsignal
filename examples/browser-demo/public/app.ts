import { BlindSignalClient, DeviceKey, type Peer, type Session } from '@blindsignal/sdk';

const params = new URLSearchParams(location.search);
// `?app=<app_id>` signs in to another application of the registry than `notes`.
const app = params.get('app') ?? 'notes';
const NAMESPACE = `${app}:demo`;
const user = params.get('user') ?? 'alice';
const device = params.get('device') ?? crypto.randomUUID().slice(0, 8);
// `?relay` connects through TURN only, when the server configures it.
const relay = params.has('relay');
// `?connectTimeout=<ms>` shortens the SDK's connection timeout (ADR 0018).
const connectTimeout = params.get('connectTimeout');
// `?pop` binds the tokens to this origin's device key (ADR 0041).
const deviceKey = params.has('pop') ? await DeviceKey.load() : undefined;
// `?pairing` makes this a new device, which asks the user's other devices to approve it (ADR 0042).
const pairing = params.has('pairing');
// `?binary` sends each message as UTF-8 bytes instead of a string: another application protocol.
const binary = params.has('binary');

const $ = (id: string) => document.getElementById(id)!;
const log = (line: string) =>
  $('log').append(Object.assign(document.createElement('li'), { textContent: line }));
const name = (peer: Pick<Peer, 'userId' | 'deviceId'>) => `${peer.userId}/${peer.deviceId}`;
$('me').textContent = `${user}/${device}`;
$('key').textContent = deviceKey?.thumbprint ?? 'none';
$('namespace').textContent = NAMESPACE;

// `?server=<url>` picks another signaling server than the demo's own.
const serverUrl =
  params.get('server') ??
  ((await (await fetch('/config')).json()) as { serverUrl: string }).serverUrl;
const client = new BlindSignalClient({
  serverUrl,
  accessTokenProvider: async () => {
    // The backend binds the token to the key whose thumbprint the device sends.
    const query = {
      user,
      device,
      app,
      ...(deviceKey && { jkt: deviceKey.thumbprint }),
      ...(pairing && { pairing: '' }),
    };
    const response = await fetch(`/token?${new URLSearchParams(query)}`);
    if (!response.ok) throw new Error(`token request failed: ${response.status}`);
    return response.text();
  },
  ...(deviceKey && { deviceKey }),
  ...(relay && { iceTransportPolicy: 'relay' as const }),
  ...(connectTimeout && { connectTimeoutMs: Number(connectTimeout) }),
});

let session: Session | undefined;

function attach(next: Session): void {
  session?.close();
  session = next;
  $('channel').textContent = 'connecting';
  log(`session with ${name(next.peer)}`);
  next.on('open', () => ($('channel').textContent = 'open'));
  next.on('connectionType', (type) => ($('connection-type').textContent = type));
  next.on('data', (data) =>
    log(`${name(next.peer)}: ${typeof data === 'string' ? data : `${data.byteLength} bytes`}`),
  );
  next.on('close', () => {
    if (session === next) $('channel').textContent = 'closed';
  });
}

const peers = new Map<string, HTMLLIElement>();

function present(peer: Pick<Peer, 'userId' | 'deviceId'>, here: boolean): void {
  const key = name(peer);
  peers.get(key)?.remove();
  peers.delete(key);
  if (!here) return;
  const button = Object.assign(document.createElement('button'), {
    type: 'button',
    textContent: `Connect to ${key}`,
  });
  button.addEventListener('click', () => {
    client
      .createSession({ namespace: NAMESPACE, ...peer })
      .then(attach)
      .catch((error: unknown) => log(`session failed: ${String(error)}`));
  });
  const item = document.createElement('li');
  item.append(button);
  peers.set(key, item);
  $('peers').append(item);
}

client.on(
  'state',
  ({ state, error }) => ($('state').textContent = error ? `${state} (${error})` : state),
);
client.on('presence', (presence) => present(presence, presence.present));
// A demo accepts every request; an application would ask its user.
client.on('sessionRequest', (request) => {
  request.accept().then(attach, (error: unknown) => log(`accept failed: ${String(error)}`));
});
// Likewise for pairing: an application would show its user the new device first.
client.on('pairingRequest', (request) => {
  log(`pairing request from ${name(request)}`);
  request.approve().then(
    () => log(`approved ${name(request)}`),
    (error: unknown) => log(`approve failed: ${String(error)}`),
  );
});
client.on('pairingEnded', ({ reason }) => log(`pairing request ended: ${reason}`));
$('pair').addEventListener('click', () => {
  $('pairing').textContent = 'asking';
  client.requestPairing(NAMESPACE).then(
    // The approval goes to the backend, which then issues tokens with the namespace.
    (result) => {
      $('pairing').textContent = result.status;
      if (result.status === 'approved') $('approval').textContent = result.approval;
    },
    (error: unknown) => ($('pairing').textContent = `failed: ${String(error)}`),
  );
});

$('send').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('message') as HTMLInputElement;
  if (session === undefined) return;
  try {
    session.send(binary ? new TextEncoder().encode(input.value) : input.value);
    log(`me: ${input.value}`);
    input.value = '';
  } catch (error) {
    log(`send failed: ${String(error)}`);
  }
});
$('close').addEventListener('click', () => session?.close());

await client.connect();
// A device being paired holds no namespace yet.
if (!pairing) {
  await client.join(NAMESPACE);
  for (const peer of await client.discover(NAMESPACE)) present(peer, true);
}
