import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';

/** The demo page on the signaling server at this port: playwright.config.ts runs one per server. */
const demo = (signalingPort: number) => `http://127.0.0.1:${3787 + signalingPort - 8787}`;

/** Each browser its own context, as two devices; a suffix keeps parallel projects apart. */
async function open(
  browser: Browser,
  user: string,
  device: string,
  query: object = {},
  signalingPort = 8787,
) {
  const page = await (await browser.newContext()).newPage();
  const sent: string[] = [];
  const received: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => sent.push(String(payload)));
    socket.on('framereceived', ({ payload }) => received.push(String(payload)));
  });
  await page.goto(`${demo(signalingPort)}/?${new URLSearchParams({ user, device, ...query })}`);
  await expect(page.locator('#state')).toHaveText('connected');
  return { page, sent, received };
}

/**
 * Playwright's WebKit names its host candidates with mDNS names it cannot resolve, and has no
 * switch to turn them off: its browsers connect only through the TURN relay (ADR 0047).
 */
function skipWithoutRelay(info: TestInfo) {
  test.skip(
    info.project.name === 'webkit' && !process.env.BLINDSIGNAL_TEST_TURN,
    'WebKit connects only through the relay of the TURN run',
  );
}

function skipDirect(info: TestInfo) {
  test.skip(info.project.name === 'webkit', 'WebKit cannot connect over host candidates');
}

// Buttons are pressed, not clicked: the device list above them changes as other tests' devices
// come and go, and a click lands where a button was, not where it is (ADR 0047).
async function send(page: Page, text: string) {
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send' }).press('Enter');
}

test('two browsers open a DataChannel, exchange messages, and close', async ({ browser }, info) => {
  skipDirect(info);
  const alice = await open(browser, 'alice', `laptop-${info.project.name}`);
  const bob = await open(browser, 'bob', `phone-${info.project.name}`);

  await alice.page
    .getByRole('button', { name: `Connect to bob/phone-${info.project.name}` })
    .press('Enter');
  for (const { page } of [alice, bob]) {
    await expect(page.locator('#channel')).toHaveText('open');
    await expect(page.locator('#connection-type')).toHaveText('direct');
  }

  await send(alice.page, 'hello bob');
  await expect(bob.page.locator('#log')).toContainText(
    `alice/laptop-${info.project.name}: hello bob`,
  );
  await send(bob.page, 'hello alice');
  await expect(alice.page.locator('#log')).toContainText(
    `bob/phone-${info.project.name}: hello alice`,
  );
  // Payloads travel only over the DataChannel, never through the signaling server.
  for (const { sent } of [alice, bob]) {
    expect(sent.some((frame) => frame.includes('"rtc.'))).toBe(true);
    expect(sent.filter((frame) => frame.includes('hello'))).toEqual([]);
  }

  await alice.page.getByRole('button', { name: 'Close' }).press('Enter');
  for (const { page } of [alice, bob]) await expect(page.locator('#channel')).toHaveText('closed');
});

test('two applications on one server keep their devices and protocols apart', async ({
  browser,
}, info) => {
  skipWithoutRelay(info);
  // The same user and device IDs in both: an identity belongs to its application (spec §6.1).
  const laptop = `laptop-apps-${info.project.name}`;
  const phone = `phone-apps-${info.project.name}`;
  const chatQuery = { app: 'chat', binary: '' };
  const notes = [await open(browser, 'alice', laptop), await open(browser, 'bob', phone)];
  const chat = [
    await open(browser, 'alice', laptop, chatQuery),
    await open(browser, 'bob', phone, chatQuery),
  ];

  for (const [alice] of [notes, chat]) {
    await alice!.page.getByRole('button', { name: `Connect to bob/${phone}` }).press('Enter');
  }
  for (const { page } of [...notes, ...chat]) {
    await expect(page.locator('#channel')).toHaveText('open');
  }
  // `notes` exchanges strings and `chat` bytes, over one signaling server that reads neither.
  await send(notes[0]!.page, 'hello notes');
  await send(chat[0]!.page, 'hello chat');
  await expect(notes[1]!.page.locator('#log')).toContainText(`alice/${laptop}: hello notes`);
  await expect(chat[1]!.page.locator('#log')).toContainText(`alice/${laptop}: 10 bytes`);

  for (const [pages, other] of [
    [notes, 'chat:demo'],
    [chat, 'notes:demo'],
  ] as const) {
    for (const { page, sent, received } of pages) {
      // Neither saw the other's namespace, and neither superseded the other's device.
      expect(received.filter((frame) => frame.includes(other))).toEqual([]);
      await expect(page.locator('#state')).toHaveText('connected');
      expect(sent.filter((frame) => frame.includes('hello'))).toEqual([]);
    }
  }
});

test('two browsers bound to device keys connect, and keep their keys across a reload', async ({
  browser,
}, info) => {
  skipWithoutRelay(info);
  const alice = await open(browser, 'alice', `pop-laptop-${info.project.name}`, { pop: '' });
  const bob = await open(browser, 'bob', `pop-phone-${info.project.name}`, { pop: '' });
  for (const { page, sent } of [alice, bob]) {
    await expect(page.locator('#key')).toHaveText(/^[\w-]{43}$/);
    expect(sent.find((frame) => frame.includes('"auth.authenticate"'))).toContain('"proof"');
  }
  expect(await alice.page.locator('#key').textContent()).not.toBe(
    await bob.page.locator('#key').textContent(),
  );

  const thumbprint = await alice.page.locator('#key').textContent();
  await alice.page.reload();
  await expect(alice.page.locator('#state')).toHaveText('connected');
  await expect(alice.page.locator('#key')).toHaveText(thumbprint!);

  await alice.page
    .getByRole('button', { name: `Connect to bob/pop-phone-${info.project.name}` })
    .press('Enter');
  for (const { page } of [alice, bob]) await expect(page.locator('#channel')).toHaveText('open');
});

test('a bound token without its proof is refused', async ({ browser }, info) => {
  const page = await (await browser.newContext()).newPage();
  const received: string[] = [];
  // Between the page and the server: drops the proof from every authentication.
  await page.routeWebSocket(/:8787/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { type: string; payload: { proof?: string } };
      if (frame.type === 'auth.authenticate') delete frame.payload.proof;
      server.send(JSON.stringify(frame));
    });
    server.onMessage((message) => {
      received.push(String(message));
      socket.send(message);
    });
  });
  const query = { user: 'mallory', device: `pop-${info.project.name}`, pop: '' };
  await page.goto(`/?${new URLSearchParams(query)}`);
  await expect.poll(() => received.some((frame) => frame.includes('"invalid_token"'))).toBe(true);
  await expect(page.locator('#state')).not.toHaveText('connected');
});

test("a new device is approved by its user's device in the namespace", async ({
  browser,
}, info) => {
  // A user of its own per project: devices of the same user in parallel runs would be asked too.
  const user = `carol-${info.project.name}`;
  const laptop = await open(browser, user, 'laptop', { pop: '' });
  const tablet = await open(browser, user, 'tablet', { pop: '', pairing: '' });

  await tablet.page.getByRole('button', { name: 'Ask to pair' }).press('Enter');
  await expect(tablet.page.locator('#pairing')).toHaveText('approved');
  await expect(laptop.page.locator('#log')).toContainText(`approved ${user}/tablet`);

  // The server checked the signature; the claims bind the tablet's key, the key is the laptop's.
  const approval = await tablet.page.locator('#approval').textContent();
  const [header, claims] = approval!
    .split('.')
    .slice(0, 2)
    .map(
      (part) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>,
    );
  expect(header).toMatchObject({ typ: 'blindsignal-pairing+jwt', alg: 'ES256' });
  const { crv, kty, x, y } = header!.jwk as Record<string, string>;
  const thumbprint = createHash('sha256')
    .update(JSON.stringify({ crv, kty, x, y }))
    .digest('base64url');
  expect(thumbprint).toBe(await laptop.page.locator('#key').textContent());
  expect(claims).toMatchObject({
    namespace: 'notes:demo',
    sub: user,
    device_id: 'tablet',
    jkt: await tablet.page.locator('#key').textContent(),
  });
});

// Each signaling server of playwright.config.ts offers one TURN URL, so a forced relay uses it.
for (const [transport, port] of [
  ['udp', 8787],
  ['tcp', 8788],
  ['tls', 8789],
] as const) {
  test(`two browsers forced to TURN connect through the relay over ${transport}`, async ({
    browser,
  }, info) => {
    test.skip(!process.env.BLINDSIGNAL_TEST_TURN, 'needs the Coturn of compose.yaml');
    test.skip(
      transport === 'tls' && info.project.name !== 'chromium',
      "Firefox and WebKit reject the test TURN server's self-signed certificate",
    );
    const suffix = `${transport}-${info.project.name}`;
    const alice = await open(browser, 'alice', `relay-laptop-${suffix}`, { relay: '' }, port);
    const bob = await open(browser, 'bob', `relay-phone-${suffix}`, { relay: '' }, port);

    await alice.page
      .getByRole('button', { name: `Connect to bob/relay-phone-${suffix}` })
      .press('Enter');
    for (const { page } of [alice, bob]) {
      await expect(page.locator('#channel')).toHaveText('open');
      await expect(page.locator('#connection-type')).toHaveText('relay');
    }
    await send(alice.page, `hello over ${transport}`);
    await expect(bob.page.locator('#log')).toContainText(
      `alice/relay-laptop-${suffix}: hello over ${transport}`,
    );
  });
}

test('two browsers without direct candidates fall back to the relay', async ({
  playwright,
}, info) => {
  test.skip(!process.env.BLINDSIGNAL_TEST_TURN, 'needs the Coturn of compose.yaml');
  test.skip(info.project.name !== 'firefox', 'only Firefox can drop host candidates');
  // The default policy, `all`, on a browser that gathers no host candidates: only the relay
  // connects, as on a network that blocks direct paths.
  const browser = await playwright.firefox.launch({
    firefoxUserPrefs: {
      'media.peerconnection.ice.loopback': true,
      'media.peerconnection.ice.no_host': true,
    },
  });
  const suffix = `fallback-${info.project.name}`;
  const alice = await open(browser, 'alice', `laptop-${suffix}`);
  const bob = await open(browser, 'bob', `phone-${suffix}`);

  await alice.page.getByRole('button', { name: `Connect to bob/phone-${suffix}` }).press('Enter');
  for (const { page } of [alice, bob]) {
    await expect(page.locator('#channel')).toHaveText('open');
    await expect(page.locator('#connection-type')).toHaveText('relay');
  }
  await send(alice.page, 'hello after fallback');
  await expect(bob.page.locator('#log')).toContainText(
    `alice/laptop-${suffix}: hello after fallback`,
  );
  await browser.close();
});

// The signaling server on 8790 offers a TURN URL that nothing listens on.
test('two browsers connect directly while TURN is unreachable', async ({ browser }, info) => {
  test.skip(!process.env.BLINDSIGNAL_TEST_TURN, 'needs the signaling servers of the TURN run');
  skipDirect(info);
  const suffix = `no-turn-${info.project.name}`;
  const alice = await open(browser, 'alice', `laptop-${suffix}`, {}, 8790);
  const bob = await open(browser, 'bob', `phone-${suffix}`, {}, 8790);

  await alice.page.getByRole('button', { name: `Connect to bob/phone-${suffix}` }).press('Enter');
  for (const { page } of [alice, bob]) {
    await expect(page.locator('#channel')).toHaveText('open');
    await expect(page.locator('#connection-type')).toHaveText('direct');
  }
  for (const { received } of [alice, bob]) {
    expect(
      received.some((frame) => frame.includes('"rtc.ice_config"') && frame.includes(':3479')),
    ).toBe(true);
  }
});

test('a session forced to an unreachable TURN server closes', async ({ browser }, info) => {
  test.skip(!process.env.BLINDSIGNAL_TEST_TURN, 'needs the signaling servers of the TURN run');
  // No candidate is ever gathered, so only the SDK's connection timeout ends the session.
  const query = { relay: '', connectTimeout: '1000' };
  const suffix = `dead-turn-${info.project.name}`;
  const alice = await open(browser, 'alice', `laptop-${suffix}`, query, 8790);
  const bob = await open(browser, 'bob', `phone-${suffix}`, query, 8790);

  await alice.page.getByRole('button', { name: `Connect to bob/phone-${suffix}` }).press('Enter');
  for (const { page } of [alice, bob]) {
    await expect(page.locator('#channel')).toHaveText('connecting');
  }
  // 1 s for the offer/answer exchange and each of the 3 ICE restarts.
  for (const { page } of [alice, bob]) {
    await expect(page.locator('#channel')).toHaveText('closed', { timeout: 15_000 });
  }
  expect(alice.sent.filter((frame) => frame.includes('"rtc.offer"'))).toHaveLength(4);
});
