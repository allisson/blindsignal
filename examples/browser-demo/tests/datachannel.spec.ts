import { expect, test, type Browser, type Page } from '@playwright/test';

/** Each browser its own context, as two devices; a suffix keeps parallel projects apart. */
async function open(browser: Browser, user: string, device: string, query: object = {}) {
  const page = await (await browser.newContext()).newPage();
  const sent: string[] = [];
  const received: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => sent.push(String(payload)));
    socket.on('framereceived', ({ payload }) => received.push(String(payload)));
  });
  await page.goto(`/?${new URLSearchParams({ user, device, ...query })}`);
  await expect(page.locator('#state')).toHaveText('connected');
  return { page, sent, received };
}

async function send(page: Page, text: string) {
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

test('two browsers open a DataChannel, exchange messages, and close', async ({ browser }, info) => {
  const alice = await open(browser, 'alice', `laptop-${info.project.name}`);
  const bob = await open(browser, 'bob', `phone-${info.project.name}`);

  await alice.page
    .getByRole('button', { name: `Connect to bob/phone-${info.project.name}` })
    .click();
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

  await alice.page.getByRole('button', { name: 'Close' }).click();
  for (const { page } of [alice, bob]) await expect(page.locator('#channel')).toHaveText('closed');
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
      transport === 'tls' && info.project.name === 'firefox',
      "Firefox rejects the test TURN server's self-signed certificate",
    );
    const query = { relay: '', server: `ws://localhost:${port}` };
    const suffix = `${transport}-${info.project.name}`;
    const alice = await open(browser, 'alice', `relay-laptop-${suffix}`, query);
    const bob = await open(browser, 'bob', `relay-phone-${suffix}`, query);

    await alice.page.getByRole('button', { name: `Connect to bob/relay-phone-${suffix}` }).click();
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

  await alice.page.getByRole('button', { name: `Connect to bob/phone-${suffix}` }).click();
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
  const query = { server: 'ws://localhost:8790' };
  const suffix = `no-turn-${info.project.name}`;
  const alice = await open(browser, 'alice', `laptop-${suffix}`, query);
  const bob = await open(browser, 'bob', `phone-${suffix}`, query);

  await alice.page.getByRole('button', { name: `Connect to bob/phone-${suffix}` }).click();
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
  const query = { relay: '', server: 'ws://localhost:8790', connectTimeout: '1000' };
  const suffix = `dead-turn-${info.project.name}`;
  const alice = await open(browser, 'alice', `laptop-${suffix}`, query);
  const bob = await open(browser, 'bob', `phone-${suffix}`, query);

  await alice.page.getByRole('button', { name: `Connect to bob/phone-${suffix}` }).click();
  for (const { page } of [alice, bob]) {
    await expect(page.locator('#channel')).toHaveText('connecting');
  }
  // 1 s for the offer/answer exchange and each of the 3 ICE restarts.
  for (const { page } of [alice, bob]) {
    await expect(page.locator('#channel')).toHaveText('closed', { timeout: 15_000 });
  }
  expect(alice.sent.filter((frame) => frame.includes('"rtc.offer"'))).toHaveLength(4);
});
