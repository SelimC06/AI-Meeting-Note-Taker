import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import TypewriterText from "./TypewriterText";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("types the full text on within the animation budget", async () => {
  const { container } = render(<TypewriterText text="hello from the caption" />);
  await waitFor(() => expect(container).toHaveTextContent("hello from the caption"), {
    timeout: 2000,
  });
});

it("renders instantly when the viewer prefers reduced motion", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true })
  );
  const { container } = render(<TypewriterText text="no animation here" />);
  expect(container).toHaveTextContent("no animation here");
});
