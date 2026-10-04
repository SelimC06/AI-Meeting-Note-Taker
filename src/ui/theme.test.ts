import { afterEach, expect, it } from "vitest";
import { applyTheme, getTheme, initTheme, setTheme } from "./theme";

afterEach(() => {
  window.localStorage.removeItem("deskrecap.theme");
  delete document.documentElement.dataset.theme;
});

it("defaults to dark when nothing is stored", () => {
  expect(getTheme()).toBe("dark");
});

it("setTheme persists and applies to the root element", () => {
  setTheme("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(window.localStorage.getItem("deskrecap.theme")).toBe("light");
  expect(getTheme()).toBe("light");

  setTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(getTheme()).toBe("dark");
});

it("initTheme applies the stored theme and follows cross-window storage events", () => {
  window.localStorage.setItem("deskrecap.theme", "light");
  initTheme();
  expect(document.documentElement.dataset.theme).toBe("light");

  // The other window (dashboard vs rail) switching themes reaches this one
  // as a storage event.
  window.dispatchEvent(new StorageEvent("storage", { key: "deskrecap.theme", newValue: "dark" }));
  expect(document.documentElement.dataset.theme).toBe("dark");

  // Unrelated keys don't touch the theme.
  window.dispatchEvent(new StorageEvent("storage", { key: "something.else", newValue: "light" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("applyTheme alone never writes storage", () => {
  applyTheme("light");
  expect(window.localStorage.getItem("deskrecap.theme")).toBeNull();
});
