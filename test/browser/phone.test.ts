/**
 * Acceptance: "Phone, keyboard, full group and no upcoming dates → CTA, inputs and alternate paths are
 * usable and legible", plus "verify all three entry routes on phone widths".
 *
 * Runs the real Workers (Miniflare on a local port) in Chromium via Playwright. The Stripe emulator serves
 * a stand-in hosted Checkout page so the whole flow happens in the browser.
 * Run with: npm run test:browser   (needs Playwright + Chromium, see README)
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, startApp } from '../helpers/app';
import { FakeStripe } from '../helpers/fake-stripe';
import { DAY, nowSec, seedConfirmed, seedListing } from '../helpers/flows';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let playwright: any = null;
try {
  playwright = require('playwright');
} catch {
  playwright = null;
}

const SHOTS = 'docs/screenshots';
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

describe.skipIf(!playwright)('phone, keyboard and edge states in a real browser', () => {
  let app: TestApp;
  let empty: TestApp;
  let base: string;
  let emptyBase: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  let invitePath: string;
  let paidLink: string;

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    const stripe = new FakeStripe();
    const checkoutOrigin = await stripe.listen();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = { PUBLIC_ORIGIN: base, STRIPE_CHECKOUT_ORIGIN: checkoutOrigin, TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '' };
    app = await startApp({ port, stripe, publicEnv: env });
    stripe.onPaid = async (s) => {
      const ev = stripe.sessionEvent('checkout.session.completed', s.id);
      await app.mf.dispatchFetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Stripe-Signature': ev.signature, 'Content-Type': 'application/json' }, body: ev.body });
    };
    const t = nowSec();
    await seedListing(app.db, { slug: 'python-pilot', title: 'Python pilot: loops and conditions', price: 1500, lessons: [{ start: t + 20 * DAY }] });
    const pkg = await seedListing(app.db, { slug: 'four-week-group', title: 'First four-session group', price: 8000, kind: 'package', lessons: [0, 7, 14, 21].map((d) => ({ start: t + (24 + d) * DAY })) });
    const full = await seedListing(app.db, { slug: 'full-group', title: 'Thursday group (full)', capacity: 8, lessons: [{ start: t + 22 * DAY }] });
    await seedConfirmed(app.db, full.id, 8);
    const admin = app.admin();
    await admin.act(`/listings/${pkg.id}/share-links`, { channel: 'whatsapp', code: 'wa-course-chat' });
    invitePath = '/i/wa-course-chat';
    const manual = await (await admin.act(`/listings/${pkg.id}/manual-booking`, { first_name: 'Priya', email: 'priya@example.com', payment_reference: 'bank transfer', amount: '80' })).text();
    paidLink = /https?:\/\/[^"\s]+\/b\/([A-Za-z0-9_-]{43})/.exec(manual)![0].replace(/^https?:\/\/[^/]+/, '');

    const emptyPort = await freePort();
    emptyBase = `http://127.0.0.1:${emptyPort}`;
    empty = await startApp({ port: emptyPort, publicEnv: { PUBLIC_ORIGIN: emptyBase, TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '' } });
    browser = await playwright.chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await empty?.close();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function layoutChecks(page: any) {
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
    }));
    expect(m.overflow, 'no horizontal scrolling').toBeLessThanOrEqual(0);
    expect(m.bodyFont).toBeGreaterThanOrEqual(16);
  }

  it('landing on a phone: heading, real next date, price and CTA above the fold', async () => {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await expect(page.getByRole('heading', { level: 1 }).textContent()).resolves.toBe('Get unstuck on Python test questions.');
    const cta = page.locator('[data-main-cta]');
    await expect(cta.textContent()).resolves.toBe('Book a seat · £15');
    const box = await cta.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(844); // visible without scrolling
    expect(box.height).toBeGreaterThanOrEqual(44); // comfortable tap target
    const card = await page.locator('.booking-card').innerText();
    expect(card).toMatch(/UK time \((GMT|BST)\)/);
    expect(card).toContain('Up to 8 students');
    await layoutChecks(page);
    await page.screenshot({ path: `${SHOTS}/phone-landing.png` });
    // Sticky CTA appears only after the main button scrolls away.
    expect(await page.locator('[data-sticky-cta]').isVisible()).toBe(false);
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(300);
    expect(await page.locator('[data-sticky-cta]').isVisible()).toBe(true);
    await page.screenshot({ path: `${SHOTS}/phone-landing-scrolled.png` });
    await ctx.close();
  });

  it('keyboard: visible focus, labelled inputs and a full booking with Checkout and confirmation', async () => {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await page.goto(base + '/');
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.hasAttribute('data-main-cta') ?? false);
    }
    expect(reached, 'CTA reachable by keyboard').toBe(true);
    const outline = await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement as Element);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: `${SHOTS}/phone-keyboard-focus.png` });
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/session\/python-pilot\/book/);
    // Every input has an accessible label.
    const unlabeled = await page.evaluate(() =>
      [...document.querySelectorAll('form input:not([type=hidden]), form textarea')].filter((el) => !(el as HTMLInputElement).labels?.length).length,
    );
    expect(unlabeled).toBe(0);
    await page.getByLabel('First name').fill('Sam');
    await page.getByLabel(/^Email/).fill('sam@example.com');
    for (const box of await page.locator('form input[type=checkbox]').all()) {
      await box.focus();
      await page.keyboard.press('Space');
    }
    await layoutChecks(page);
    await page.screenshot({ path: `${SHOTS}/phone-booking-form.png`, fullPage: true });
    await page.getByRole('button', { name: /Continue to payment/ }).press('Enter');
    await page.waitForURL(/\/c\/pay\//);
    await page.screenshot({ path: `${SHOTS}/phone-test-checkout.png` });
    await page.getByRole('button', { name: 'Book' }).click();
    await page.waitForURL(/\/booking\/bk_/);
    const text = await page.locator('main').innerText();
    expect(text).toContain("You're booked!");
    expect(text).toContain('Open call link');
    await page.screenshot({ path: `${SHOTS}/phone-confirmed.png`, fullPage: true });
    await ctx.close();
  });

  it('entry routes on a phone: invite link and already-paid private link', async () => {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await page.goto(base + invitePath);
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/?g=four-week-group');
    const card = await page.locator('.booking-card').innerText();
    expect(card).toContain('Your invitation');
    expect(card).toContain('First four-session group');
    await expect(page.locator('[data-main-cta]').textContent()).resolves.toBe('Book a seat · £80');
    await layoutChecks(page);
    await page.screenshot({ path: `${SHOTS}/phone-invite.png` });

    const paid = await browser.newContext(PHONE);
    const p2 = await paid.newPage();
    await p2.goto(base + paidLink);
    expect(p2.url()).not.toContain(paidLink.split('/b/')[1]); // token cleaned from the address bar
    const main = await p2.locator('main').innerText();
    expect(main).toContain('Confirmed');
    expect(main).toContain('Session 4 of 4');
    await layoutChecks(p2);
    await p2.screenshot({ path: `${SHOTS}/phone-private-booking.png`, fullPage: true });
    await paid.close();
    await ctx.close();
  });

  it('a full group offers the waitlist and other dates', async () => {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await page.goto(base + '/session/full-group');
    expect(await page.locator('.state-soldout').innerText()).toContain('Sold out');
    const cta = page.locator('[data-main-cta]');
    await expect(cta.textContent()).resolves.toBe('Join the waitlist');
    await layoutChecks(page);
    await page.screenshot({ path: `${SHOTS}/phone-full-group.png`, fullPage: true });
    await cta.click();
    await page.waitForURL(/\/waitlist\?l=full-group/);
    expect(await page.getByLabel(/weekly Python practice question/).isChecked()).toBe(false);
    expect(await page.getByLabel(/seat opens/).isChecked()).toBe(true);
    await ctx.close();
  });

  it('with no upcoming dates the CTA becomes "Get the next date"', async () => {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await page.goto(emptyBase + '/');
    const cta = page.locator('[data-main-cta]');
    await expect(cta.textContent()).resolves.toBe('Get the next date');
    expect(await page.locator('.booking-card').innerText()).toContain('No dates published yet');
    await layoutChecks(page);
    await page.screenshot({ path: `${SHOTS}/phone-no-dates.png` });
    await cta.click();
    await page.waitForURL(/\/waitlist$/);
    await page.getByLabel('Email', { exact: true }).fill('next@example.com');
    await page.getByRole('button', { name: 'Get the next date' }).click();
    expect(await page.locator('main').innerText()).toContain("You're on the list");
    await ctx.close();
  });

  it('desktop: the booking card sits beside the hero', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    const h1 = await page.locator('h1').boundingBox();
    const card = await page.locator('.booking-card').boundingBox();
    expect(card.x).toBeGreaterThan(h1.x + 300);
    expect(Math.abs(card.y - h1.y)).toBeLessThan(160);
    await page.screenshot({ path: `${SHOTS}/desktop-landing.png` });
    await ctx.close();
  });
});
