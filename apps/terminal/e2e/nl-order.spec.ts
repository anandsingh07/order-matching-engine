import { expect, test, type Page } from "@playwright/test";

// The "Type an order" box, with no model: the gateway's Ollama URL points at a
// closed port (playwright.config.ts), so the built-in rules answer. This file
// runs before terminal.spec.ts against the same exchange, so it uses its own
// traders and a price (INFY 1790.00) that spec never checks, never trades, and
// cancels what it places.

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

const box = (page: Page) => page.getByRole("form", { name: "Plain-English order" });
const ticket = (page: Page) => page.getByRole("form", { name: "Order entry" });
const openOrders = (page: Page, n: number) => page.getByRole("tablist", { name: "Account" }).getByRole("tab", { name: `Open orders (${n})` });

async function type(page: Page, text: string) {
  const input = box(page).getByLabel("Type an order");
  await input.fill(text);
  await input.press("Enter");
}

test("a typed order fills in the ticket, sends nothing by itself, and a typed cancel lists what it cancels", async ({ page }) => {
  await login(page, "e2e-typist");
  await selectSymbol(page, "TCS");
  // The box is its own form: the ticket's name and its locators are unchanged.
  await expect(ticket(page)).toHaveCount(1);

  await type(page, "buy 10 infosys at 1790");
  await expect(box(page)).toContainText("Buy 10 INFY at 1790.00 INR (limit, good till cancelled)");
  await expect(box(page)).toContainText("Read by the built-in rules");
  // Focus stays in the text box: Enter again cannot reach Fill in.
  await expect(box(page).getByLabel("Type an order")).toBeFocused();
  await expect(openOrders(page, 0)).toBeVisible();

  await box(page).getByRole("button", { name: "Fill in the INFY ticket" }).click();
  // The ticket switched to INFY and holds the order; focus is on its hint, not its button.
  await expect(ticket(page).getByRole("button", { name: "Buy INFY" })).toBeVisible();
  await expect(page.getByLabel("Price", { exact: true })).toHaveValue("1790.00");
  await expect(page.getByLabel("Quantity")).toHaveValue("10");
  await expect(page.getByRole("tab", { name: "Limit" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("group", { name: "Side" }).getByRole("button", { name: "buy" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#ticket-from-text")).toBeFocused();
  await expect(box(page).getByLabel("Type an order")).toHaveValue("");
  await expect(openOrders(page, 0)).toBeVisible();

  // Only the user's own press sends it.
  await ticket(page).getByRole("button", { name: "Buy INFY" }).click();
  await expect(openOrders(page, 1)).toBeVisible();
  await expect(page.locator("#ticket-from-text")).toHaveCount(0);

  await type(page, "cancel my infy orders");
  await expect(box(page)).toContainText("Cancel your open INFY orders");
  await expect(box(page).getByRole("list", { name: "Orders to cancel" }).getByRole("listitem")).toHaveCount(1);
  await expect(openOrders(page, 1)).toBeVisible();
  await box(page).getByRole("button", { name: "Cancel 1 open order" }).click();
  await expect(openOrders(page, 0)).toBeVisible();
});

test("without a model the rules still answer, and the box says why", async ({ page }) => {
  await login(page, "e2e-typist-2");
  await selectSymbol(page, "HDFCBANK");

  // Too loose for the rules, so the gateway asks the model, which is not running.
  await type(page, "sell 3 tcs if it falls to 4000");
  await expect(box(page)).toContainText("The local model is not running (start Ollama), so only the built-in rules read this.");
  await expect(box(page)).toContainText("Try: buy 10 TCS at 4100");
  await expect(box(page)).not.toContainText("http://");
  await expect(box(page).getByRole("button", { name: /^Fill in/ })).toHaveCount(0);
  await expect(box(page)).toContainText("The local model is offline");

  // A cancel with nothing to cancel offers no action.
  await type(page, "cancel my reliance orders");
  await expect(box(page)).toContainText("You have no open RELIANCE orders.");
  await expect(box(page).getByRole("button", { name: /^Cancel \d/ })).toHaveCount(0);

  // Esc clears the result; Discard does too and returns focus to the text box.
  await box(page).getByLabel("Type an order").press("Escape");
  await expect(box(page)).not.toContainText("You have no open RELIANCE orders.");
  await type(page, "buy 5 tcs at market fill or kill");
  // The ticket cannot send fill-or-kill on a market order: the preview says so before anything is filled in.
  await expect(box(page)).toContainText("Warning: The ticket has no fill-or-kill for market orders");
  await box(page).getByRole("button", { name: "Discard" }).click();
  await expect(box(page).getByLabel("Type an order")).toBeFocused();
  await expect(ticket(page).getByRole("button", { name: "Buy HDFCBANK" })).toBeVisible();
});
