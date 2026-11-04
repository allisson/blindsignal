import { expect, test, type Browser } from '@playwright/test';

/** A device: its own browser context, so its own cookie, device key, and device ID. */
async function signIn(browser: Browser, user: string) {
  const page = await (await browser.newContext()).newPage();
  const sent: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => sent.push(String(payload))),
  );
  await page.goto('/');
  await page.getByLabel('User').fill(user);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#state')).toHaveText('connected');
  return { page, sent, deviceId: (await page.locator('#device').textContent())! };
}

test("a user's new device is paired by the first, then they exchange a message", async ({
  browser,
}, info) => {
  // A user per run: the projects and repeats share one backend and signaling server.
  const user = `alice-${info.project.name}-${info.repeatEachIndex}`;
  const laptop = await signIn(browser, user);
  await expect(laptop.page.locator('#pair')).toBeHidden();

  const tablet = await signIn(browser, user);
  await expect(tablet.page.locator('#pair')).toBeVisible();
  await tablet.page.getByRole('button', { name: 'Ask to pair' }).click();
  await laptop.page.getByRole('button', { name: `Approve ${tablet.deviceId}` }).click();
  await expect(tablet.page.locator('#pair')).toBeHidden();
  await expect(tablet.page.locator('#state')).toHaveText('connected');
  // Joined now: the laptop sees it arrive, and the tablet finds the laptop.
  await expect(
    laptop.page.getByRole('button', { name: `Connect to ${tablet.deviceId}` }),
  ).toBeVisible();
  // Playwright's WebKit connects only through a TURN relay, which this suite has none of (ADR 0047).
  if (info.project.name === 'webkit') return;

  await tablet.page.getByRole('button', { name: `Connect to ${laptop.deviceId}` }).click();
  await expect(laptop.page.locator('#log')).toContainText(`connected to ${tablet.deviceId}`);
  await expect(tablet.page.locator('#log')).toContainText(`connected to ${laptop.deviceId}`);
  await tablet.page.getByLabel('Message').fill('hello laptop');
  await tablet.page.getByRole('button', { name: 'Send' }).click();
  await expect(laptop.page.locator('#log')).toContainText(`${tablet.deviceId}: hello laptop`);
  // The message travels only over the DataChannel, never through the signaling server.
  for (const { sent } of [laptop, tablet]) {
    expect(sent.filter((frame) => frame.includes('hello laptop'))).toEqual([]);
  }
});

test('signing in waits for the page to load', async ({ page }, info) => {
  // A slow load: the button stays disabled until the page's handlers are attached.
  await page.route('**/config', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto('/');
  await page.getByLabel('User').fill(`carol-${info.project.name}-${info.repeatEachIndex}`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#state')).toHaveText('connected');
});

test('a device keeps its ID across a reload', async ({ browser }, info) => {
  const { page, deviceId } = await signIn(
    browser,
    `bob-${info.project.name}-${info.repeatEachIndex}`,
  );
  await page.reload();
  await expect(page.locator('#device')).toHaveText(deviceId);
});
