import { expect, test, type Browser, type Page } from '@playwright/test';

/** Each browser its own context, as two devices; a suffix keeps parallel projects apart. */
async function open(browser: Browser, user: string, device: string) {
  const page = await (await browser.newContext()).newPage();
  const sent: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => sent.push(String(payload))),
  );
  await page.goto(`/?${new URLSearchParams({ user, device })}`);
  await expect(page.locator('#state')).toHaveText('connected');
  return { page, sent };
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
