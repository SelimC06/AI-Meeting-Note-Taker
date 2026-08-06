import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import ErrorToast from "./ErrorToast";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("renders nothing when message is null", () => {
  const { container } = render(<ErrorToast message={null} onDismiss={vi.fn()} />);
  expect(container.firstChild).toBeNull();
});

it("renders the message and a dismiss button when message is set", () => {
  const { getByText, getByRole } = render(
    <ErrorToast message="Couldn't reach the app backend — is it running?" onDismiss={vi.fn()} />
  );
  expect(getByText("Couldn't reach the app backend — is it running?")).toBeInTheDocument();
  expect(getByRole("button", { name: "close" })).toBeInTheDocument();
});

it("calls onDismiss when the close button is clicked", () => {
  const onDismiss = vi.fn();
  const { getByRole } = render(<ErrorToast message="boom" onDismiss={onDismiss} />);
  fireEvent.click(getByRole("button", { name: "close" }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("auto-dismisses after 6 seconds", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  render(<ErrorToast message="boom" onDismiss={onDismiss} />);

  expect(onDismiss).not.toHaveBeenCalled();
  vi.advanceTimersByTime(6000);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("calls electronAPI.expandRail(true) when a message appears and expandRail(false) when it clears", () => {
  const expandRail = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("electronAPI", { expandRail });

  const { rerender } = render(<ErrorToast message="boom" onDismiss={vi.fn()} />);
  expect(expandRail).toHaveBeenCalledWith(true);

  rerender(<ErrorToast message={null} onDismiss={vi.fn()} />);
  expect(expandRail).toHaveBeenCalledWith(false);
});

it("does not throw when window.electronAPI is undefined", () => {
  expect(() =>
    render(<ErrorToast message="boom" onDismiss={vi.fn()} />)
  ).not.toThrow();
});
