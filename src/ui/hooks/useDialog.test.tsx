import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { useDialog } from "./useDialog";

afterEach(() => {
  cleanup();
});

function Dialog({ onEscape, focusSecond = false }: { onEscape?: () => void; focusSecond?: boolean }) {
  const secondRef = useRef<HTMLButtonElement | null>(null);
  const { dialogProps, titleId } = useDialog({ onEscape, initialFocusRef: focusSecond ? secondRef : undefined });
  return (
    <div {...dialogProps}>
      <h2 id={titleId}>Title</h2>
      <button>first</button>
      <button ref={secondRef}>second</button>
      <button disabled>disabled</button>
      <button>last</button>
    </div>
  );
}

function Host({ onEscape }: { onEscape?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && <Dialog onEscape={() => { onEscape?.(); setOpen(false); }} />}
    </>
  );
}

it("exposes dialog semantics labelled by its heading", () => {
  render(<Dialog />);
  const dialog = screen.getByRole("dialog", { name: "Title" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
});

it("moves focus to the first focusable element on open, or to initialFocusRef", () => {
  const { unmount } = render(<Dialog />);
  expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
  unmount();

  render(<Dialog focusSecond />);
  expect(screen.getByRole("button", { name: "second" })).toHaveFocus();
});

it("keeps Tab and Shift+Tab inside the dialog, skipping disabled controls", () => {
  render(<Dialog />);
  const first = screen.getByRole("button", { name: "first" });
  const last = screen.getByRole("button", { name: "last" });

  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(first).toHaveFocus();

  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(last).toHaveFocus();
});

it("pulls focus back in when Tab is pressed from outside the dialog", () => {
  render(
    <>
      <button>outside</button>
      <Dialog />
    </>
  );
  const outside = screen.getByRole("button", { name: "outside" });
  outside.focus();
  fireEvent.keyDown(outside, { key: "Tab" });
  expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
});

it("closes on Escape and returns focus to the element that opened it", () => {
  const onEscape = vi.fn();
  render(<Host onEscape={onEscape} />);
  const opener = screen.getByRole("button", { name: "open" });
  opener.focus();
  fireEvent.click(opener);
  expect(screen.getByRole("button", { name: "first" })).toHaveFocus();

  fireEvent.keyDown(document.activeElement!, { key: "Escape" });

  expect(onEscape).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it("ignores Escape when no onEscape is given (a dialog that must be answered)", () => {
  render(<Dialog />);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("only the topmost of two open dialogs reacts to Escape", () => {
  const outer = vi.fn();
  const inner = vi.fn();
  render(
    <>
      <Dialog onEscape={outer} />
      <Dialog onEscape={inner} />
    </>
  );
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(inner).toHaveBeenCalledTimes(1);
  expect(outer).not.toHaveBeenCalled();
});
