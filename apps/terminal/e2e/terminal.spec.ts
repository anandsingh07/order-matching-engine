import { expect, test, type Page } from "@playwright/test";

// Each test trades its own symbol so they cannot disturb each other's books.

async function login(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("Trader name").fill(name);
  await page.getByRole("button", { name: "Start trading" }).click();
  await expect(page.getByRole("navigation", { name: "Instruments" })).toBeVisible();
}

async function selectSymbol(page: Page, symbol: string) {
  await page.getByRole("navigation", { name: "Instruments" }).getByRole("button", { name: new RegExp(`^${symbol}`) }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^(Buy|Sell) ${symbol}$`) })).toBeVisible();
}

async function placeLimit(page: Page, side: "buy" | "sell", price: string, quantity: string) {
  await page.getByRole("group", { name: "Side" }).getByRole("button", { name: side }).click();
  await page.getByRole("tab", { name: "Limit" }).click();
  await page.getByLabel("Price", { exact: true }).fill(price);
  await page.getByLabel("Quantity").fill(quantity);
  await page
    .getByRole("form", { name: "Order entry" })
    .getByRole("button", { name: new RegExp(`^${side === "buy" ? "Buy" : "Sell"} [A-Z]+$`) })
    .click();
}

const accountTab = (page: Page, name: RegExp) => page.getByRole("tablist", { name: "Account" }).getByRole("tab", { name });

test("places a resting order, shows it on the book, and cancels it", async ({ page }) => {
  await login(page, "e2e-alice");
  await selectSymbol(page, "INFY");
  await placeLimit(page, "buy", "1800.00", "10");

  await expect(accountTab(page, /Open orders \(1\)/)).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "1800.00" });
  await expect(row).toContainText("Open");
  await expect(page.getByRole("button", { name: /^Sell at 1800.00,/ })).toBeVisible(); // its book level

  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(accountTab(page, /Open orders \(0\)/)).toBeVisible();
  await accountTab(page, /Order history/).click();
  await expect(page.getByRole("row").filter({ hasText: "1800.00" })).toContainText("Cancelled");
  await expect(page.getByRole("button", { name: /^Sell at 1800.00,/ })).toHaveCount(0);
});

test("two traders trade: both get fills and positions, everyone sees the trade", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await login(alice, "e2e-seller");
  await login(bob, "e2e-buyer");
  await selectSymbol(alice, "HDFCBANK");
  await selectSymbol(bob, "HDFCBANK");

  await placeLimit(alice, "sell", "1720.00", "5");
  await expect(accountTab(alice, /Open orders \(1\)/)).toBeVisible();
  await placeLimit(bob, "buy", "1720.00", "5");

  for (const [page, side, position] of [
    [bob, "BUY", "5"],
    [alice, "SELL", "-5"],
  ] as const) {
    await expect(accountTab(page, /Fills \(1\)/)).toBeVisible();
    await accountTab(page, /Fills/).click();
    await expect(page.getByRole("row").filter({ hasText: "1720.00" })).toContainText(side);
    await accountTab(page, /Positions/).click();
    const positionRow = page.getByRole("row").filter({ hasText: "HDFCBANK" });
    await expect(positionRow.getByRole("cell").nth(1)).toHaveText(position);
    // The trade tape and the header ticker show the print.
    await expect(page.getByRole("region").filter({ hasText: "Trades" }).getByText("1720.00").first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Instruments" })).toContainText("1720.00");
  }
  await expect(accountTab(alice, /Open orders \(0\)/)).toBeVisible();
});

test("explains invalid input and sends nothing", async ({ page }) => {
  await login(page, "e2e-validator");
  await selectSymbol(page, "TCS");
  await placeLimit(page, "buy", "4100.03", "10");
  await expect(page.getByRole("form", { name: "Order entry" }).getByRole("alert")).toHaveText("Price must be a multiple of 0.05");
  await placeLimit(page, "buy", "4100.00", "2.5");
  await expect(page.getByRole("form", { name: "Order entry" }).getByRole("alert")).toHaveText("Quantity must be a whole number");
  await expect(accountTab(page, /Open orders \(0\)/)).toBeVisible();
  await accountTab(page, /Order history/).click();
  await expect(page.getByText("No finished orders yet.")).toBeVisible();
});

test("clicking a book level fills in the order ticket", async ({ browser }) => {
  const maker = await (await browser.newContext()).newPage();
  const taker = await (await browser.newContext()).newPage();
  await login(maker, "e2e-maker");
  await login(taker, "e2e-clicker");
  await selectSymbol(maker, "RELIANCE");
  await selectSymbol(taker, "RELIANCE");
  await placeLimit(maker, "sell", "2950.00", "3");

  await taker.getByRole("button", { name: /^Buy at 2950.00,/ }).click();
  await expect(taker.getByLabel("Price", { exact: true })).toHaveValue("2950.00");
  await expect(taker.getByRole("group", { name: "Side" }).getByRole("button", { name: "buy" })).toHaveAttribute("aria-pressed", "true");
});

test("shows the account and refuses an order outside the price band", async ({ page }) => {
  await login(page, "e2e-risk");
  await selectSymbol(page, "TCS");
  const ticket = page.getByRole("form", { name: "Order entry" });
  await expect(ticket).toContainText("1,000,000.00 INR");
  await expect(page.getByLabel("Account balance")).toContainText("Equity 1,000,000.00");
  // A fresh market has no volatility forecast yet, so the static limits are shown.
  await expect(page.getByLabel("Volatility forecast")).toHaveText("Volatility forecast warming up · band ±10% · halt on 5% in 1m");

  await placeLimit(page, "buy", "4600.00", "1"); // 12% above the reference price
  await expect(page.getByText("Order rejected: price outside band")).toBeVisible();
  await accountTab(page, /Order history/).click();
  await expect(page.getByRole("row").filter({ hasText: "4600.00" })).toContainText("Rejected");
});

test("a fast price move halts trading, the terminal explains the auction, and trading reopens", async ({ browser }) => {
  test.setTimeout(60_000);
  const seller = await (await browser.newContext()).newPage();
  const buyer = await (await browser.newContext()).newPage();
  await login(seller, "e2e-halt-seller");
  await login(buyer, "e2e-halt-buyer");
  await selectSymbol(seller, "BTCUSDT");
  await selectSymbol(buyer, "BTCUSDT");

  // A trade at 80,000, then one 6.25% higher: more than the breaker's 5%.
  await placeLimit(seller, "sell", "80000.00", "0.01");
  await placeLimit(buyer, "buy", "80000.00", "0.01");
  await expect(accountTab(buyer, /Fills \(1\)/)).toBeVisible();
  await placeLimit(seller, "sell", "85000.00", "0.01");
  await placeLimit(buyer, "buy", "85000.00", "0.01");

  const banner = buyer.getByRole("status").filter({ hasText: "Trading halted" });
  await expect(banner).toBeVisible();
  await expect(buyer.getByRole("navigation", { name: "Instruments" })).toContainText("HALTED");

  // The ticket explains, before sending, that market orders must wait.
  const ticket = buyer.getByRole("form", { name: "Order entry" });
  await ticket.getByRole("tab", { name: "Market" }).click();
  await ticket.getByLabel("Quantity").fill("0.01");
  await ticket.getByRole("button", { name: /^Buy BTCUSDT$/ }).click();
  await expect(ticket.getByRole("alert")).toHaveText("During an auction only GTC limit and stop orders are accepted");

  // After the halt (4 s in the test setup) the auction uncrosses and trading resumes.
  await expect(banner).toBeHidden({ timeout: 15_000 });
  await expect(buyer.getByRole("navigation", { name: "Instruments" })).not.toContainText("HALTED");
  // The ticket's auction message goes with the auction.
  await expect(ticket.getByRole("alert")).toBeHidden();
});
