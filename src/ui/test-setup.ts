import "@testing-library/jest-dom/vitest";

// jsdom does not implement Element.prototype.scrollIntoView at all --
// Chat.tsx's auto-scroll effect calls it unconditionally on every message
// update, so any test that renders Chat (directly or via App) needs this to
// exist or the call throws inside a useEffect, which its ErrorBoundary then
// silently swallows (rendering nothing instead of the real content).
// Individual test files that want to assert ON scrollIntoView calls
// (e.g. Chat.test.tsx) can still override this with their own vi.fn().
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
