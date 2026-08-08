import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./formatRelativeTime";

const NOW = new Date("2026-08-08T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

it('returns "just now" for a timestamp under a minute old', () => {
  expect(formatRelativeTime(new Date(NOW - 30_000).toISOString())).toBe("just now");
});

it("returns minutes ago for a timestamp under an hour old", () => {
  expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString())).toBe("5m ago");
});

it("returns hours ago for a timestamp under a day old", () => {
  expect(formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString())).toBe("3h ago");
});

it("returns days ago for a timestamp a day or more old", () => {
  expect(formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString())).toBe("2d ago");
});

it("returns an empty string for an unparseable timestamp", () => {
  expect(formatRelativeTime("not-a-date")).toBe("");
});
