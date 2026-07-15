import { expect, test } from "@playwright/test";

test("home page renders the M0 scaffold status", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "OTN Insights" })).toBeVisible();
  await expect(page.getByTestId("m0-status")).toHaveText("M0 scaffold: operational.");
});
