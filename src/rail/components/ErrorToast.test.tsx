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

it("calls electronAPI.setRailErrorVisible(true) when a message appears and (false) when it clears", () => {
  const setRailErrorVisible = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("electronAPI", { setRailErrorVisible });

  const { rerender } = render(<ErrorToast message="boom" onDismiss={vi.fn()} />);
  expect(setRailErrorVisible).toHaveBeenCalledWith(true);

  rerender(<ErrorToast message={null} onDismiss={vi.fn()} />);
  expect(setRailErrorVisible).toHaveBeenCalledWith(false);
});

it("does not throw when window.electronAPI is undefined", () => {
  expect(() =>
    render(<ErrorToast message="boom" onDismiss={vi.fn()} />)
  ).not.toThrow();
});

it("renders an action button when action is provided", () => {
  const onClick = vi.fn();
  const { getByRole } = render(
    <ErrorToast
      message="Screen or microphone access denied — check your OS privacy settings."
      onDismiss={vi.fn()}
      action={{ label: "open privacy settings", onClick }}
    />
  );
  const actionButton = getByRole("button", { name: "open privacy settings" });
  expect(actionButton).toBeInTheDocument();
  fireEvent.click(actionButton);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("does not render an action button when action is omitted", () => {
  const { queryByRole } = render(
    <ErrorToast message="boom" onDismiss={vi.fn()} />
  );
  expect(queryByRole("button", { name: "open privacy settings" })).toBeNull();
});

it("does not auto-dismiss when an action is present", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  render(
    <ErrorToast
      message="Couldn't reach the app backend — is it running?"
      onDismiss={onDismiss}
      action={{ label: "retry upload", onClick: vi.fn() }}
    />
  );

  vi.advanceTimersByTime(60000);
  expect(onDismiss).not.toHaveBeenCalled();
});

it("clicking the action button does not also dismiss the toast", () => {
  const onDismiss = vi.fn();
  const onClick = vi.fn();
  const { getByRole } = render(
    <ErrorToast
      message="boom"
      onDismiss={onDismiss}
      action={{ label: "open privacy settings", onClick }}
    />
  );
  fireEvent.click(getByRole("button", { name: "open privacy settings" }));
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(onDismiss).not.toHaveBeenCalled();
});
