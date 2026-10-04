import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import LiveCaptions from "./LiveCaptions";

const setRailCaptionsVisible = vi.fn();

beforeEach(() => {
  window.electronAPI = {
    ...(window.electronAPI ?? {}),
    setRailCaptionsVisible,
  } as typeof window.electronAPI;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const caption = (id: number, speaker: "You" | "Others", text: string) => ({ id, speaker, text });

it("renders nothing and reports hidden to main while not visible", () => {
  const { container } = render(<LiveCaptions visible={false} captions={[]} />);
  expect(container).toBeEmptyDOMElement();
  expect(setRailCaptionsVisible).toHaveBeenCalledWith(false);
});

it("reports visible to main (so the window grows) and shows a listening placeholder", () => {
  render(<LiveCaptions visible captions={[]} />);
  expect(setRailCaptionsVisible).toHaveBeenCalledWith(true);
  expect(screen.getByRole("log", { name: /live captions/i })).toHaveTextContent(/listening for speech/);
});

it("shows only the newest caption, like real closed captions", async () => {
  render(
    <LiveCaptions
      visible
      captions={[
        caption(1, "You", "oldest line"),
        caption(2, "Others", "second"),
        caption(3, "You", "third"),
        caption(4, "Others", "newest"),
      ]}
    />
  );
  const log = screen.getByRole("log", { name: /live captions/i });
  // A history stack half-clipped against the fixed panel height; only the
  // line being spoken is shown now.
  expect(log).not.toHaveTextContent("oldest line");
  expect(log).not.toHaveTextContent("second");
  expect(log).not.toHaveTextContent("third");
  // The speaker chip sits in the card's status strip; the text types on.
  expect(log).toHaveTextContent("them");
  await waitFor(() => expect(log).toHaveTextContent("newest"));
});

it("reports hidden on unmount", () => {
  const { unmount } = render(<LiveCaptions visible captions={[]} />);
  setRailCaptionsVisible.mockClear();
  unmount();
  expect(setRailCaptionsVisible).toHaveBeenCalledWith(false);
});
