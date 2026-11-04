import { BlindSignalClient, BlindSignalError, DeviceKey, type Session } from '@blindsignal/sdk';

const $ = (id: string) => document.getElementById(id)!;
const log = (line: string) =>
  $('log').append(Object.assign(document.createElement('li'), { textContent: line }));

/** A POST to this application's own backend (examples/backend-issuer). */
async function post(path: string, body: object): Promise<Response> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response;
}

const { serverUrl, appId } = (await (await fetch('/config')).json()) as {
  serverUrl: string;
  appId: string;
};
// This origin's key and device ID: both survive a reload, and the backend binds tokens to the key.
const deviceKey = await DeviceKey.load();
const deviceId = localStorage.getItem('deviceId') ?? crypto.randomUUID();
localStorage.setItem('deviceId', deviceId);
$('device').textContent = deviceId;

const client = new BlindSignalClient({
  serverUrl,
  accessTokenProvider: async () => (await post('/token', { deviceId })).text(),
  deviceKey,
});
client.on('state', ({ state }) => ($('state').textContent = state));

let session: Session | undefined;
function attach(next: Session): void {
  session = next;
  next.on('open', () => log(`connected to ${next.peer.deviceId}`));
  next.on('data', (data) =>
    log(`${next.peer.deviceId}: ${typeof data === 'string' ? data : `${data.byteLength} bytes`}`),
  );
}
client.on('sessionRequest', (request) => void request.accept().then(attach));

// The user approves each new device of theirs; the approval is signed with this device's key.
client.on('pairingRequest', (request) => {
  const button = Object.assign(document.createElement('button'), {
    type: 'button',
    textContent: `Approve ${request.deviceId}`,
  });
  button.addEventListener('click', () => {
    button.remove();
    void request.approve();
  });
  $('log').append(button);
});

function listDevice(namespace: string, userId: string, peerId: string): void {
  const button = Object.assign(document.createElement('button'), {
    type: 'button',
    textContent: `Connect to ${peerId}`,
  });
  button.addEventListener('click', () => {
    void client.createSession({ namespace, userId, deviceId: peerId }).then(attach);
  });
  const item = Object.assign(document.createElement('li'), { id: peerId });
  item.append(button);
  $('devices').append(item);
}

/** Joins the user's namespace; a device the user has not paired yet may only ask to be. */
async function start(user: string): Promise<void> {
  const namespace = `${appId}:${user}`;
  await client.connect();
  try {
    await client.join(namespace);
  } catch (error) {
    if (!(error instanceof BlindSignalError && error.code === 'not_authorized')) throw error;
    $('pair').hidden = false;
    $('ask').onclick = () => void pair(user, namespace).catch((e: unknown) => log(String(e)));
    return;
  }
  client.on('presence', (peer) => {
    document.getElementById(peer.deviceId)?.remove();
    if (peer.present) listDevice(namespace, peer.userId, peer.deviceId);
  });
  for (const peer of await client.discover(namespace)) listDevice(namespace, user, peer.deviceId);
}

/** Asks the user's devices to approve this one, and takes the approval to the backend. */
async function pair(user: string, namespace: string): Promise<void> {
  $('pairing').textContent = 'waiting for approval';
  const result = await client.requestPairing(namespace);
  $('pairing').textContent = result.status;
  if (result.status !== 'approved') return;
  await post('/pairings', { deviceId, namespace, approval: result.approval });
  // The next token holds the namespace: reconnect to use it.
  $('pair').hidden = true;
  client.close();
  await start(user);
}

$('login').addEventListener('submit', (event) => {
  event.preventDefault();
  const user = ($('user') as HTMLInputElement).value;
  void (async () => {
    // Stands in for the application's own sign-in, then enrolls this device's key.
    await post('/login', { user });
    await post('/devices', { deviceId, jkt: deviceKey.thumbprint });
    await start(user);
  })().catch((error: unknown) => log(String(error)));
});

$('send').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('message') as HTMLInputElement;
  session?.send(input.value);
  log(`me: ${input.value}`);
  input.value = '';
});
