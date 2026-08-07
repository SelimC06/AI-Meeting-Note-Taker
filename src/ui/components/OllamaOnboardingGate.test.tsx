import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OllamaOnboardingGate from "./OllamaOnboardingGate";
import { useOllamaReadiness } from "../hooks/useOllamaReadiness";

vi.mock("../hooks/useOllamaReadiness");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("clears the pending copy-feedback timer on unmount", async () => {
  vi.mocked(useOllamaReadiness).mockReturnValue({
    status: "model-missing",
    model: "gemma3:4b",
    recheck: vi.fn(),
    isRechecking: false,
  });

  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });

  // Asserting on the "not wrapped in act" console.error warning doesn't work
  // here: React 19.2's setState-on-unmounted-fiber path is a silent no-op in
  // dev mode with no console output at all, so that assertion would pass
  // whether or not the timer was actually cleared -- it wouldn't discriminate
  // between the buggy and fixed implementations. Spying on
  // setTimeout/clearTimeout gives a genuine, version-independent proof that
  // the cleanup ran.
  const setTimeoutSpy = vi.spyOn(global, "setTimeout");
  const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

  const { unmount } = render(<OllamaOnboardingGate />);
  const copyButton = await screen.findByRole("button", { name: /copy/i });
  fireEvent.click(copyButton);

  await screen.findByRole("button", { name: /copied/i });

  const copyTimeoutCall = setTimeoutSpy.mock.calls.findIndex(
    (args) => typeof args[1] === "number" && args[1] === 2000
  );
  expect(copyTimeoutCall).toBeGreaterThanOrEqual(0);
  const copyTimeoutId = setTimeoutSpy.mock.results[copyTimeoutCall].value;

  unmount();

  expect(clearTimeoutSpy).toHaveBeenCalledWith(copyTimeoutId);

  setTimeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
});
