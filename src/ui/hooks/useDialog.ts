import { useEffect, useId, useRef, type RefObject } from "react";

// What Tab can land on inside a dialog. Disabled controls and anything
// explicitly taken out of the tab order are skipped.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

// Open dialogs, innermost last. Only the top one handles Tab/Escape, so a
// dialog opened over another (or over a context menu's own Escape handling)
// doesn't have both react to one key press.
const dialogStack: symbol[] = [];

// For key handling outside dialogs (SessionContextMenu's Escape): while a
// dialog is open, Escape belongs to it.
export function isDialogOpen(): boolean {
  return dialogStack.length > 0;
}

interface UseDialogOptions {
  // Escape closes the dialog when given. Left out for a dialog that must be
  // answered explicitly (the Ollama setup gate).
  onEscape?: () => void;
  // Where focus goes on open; defaults to the first focusable element, or
  // the dialog itself if it has none.
  initialFocusRef?: RefObject<HTMLElement | null>;
}

// Shared modal-dialog behavior for SettingsModal, NotesModal,
// RecordingConsentModal and OllamaOnboardingGate: moves focus into the
// dialog on open (the consent notice is triggered from the rail window, so
// without this its buttons were never focused at all), keeps Tab/Shift+Tab
// inside it, closes on Escape where that makes sense, and hands focus back
// to whatever had it before once the dialog goes away. Spread `dialogProps`
// onto the dialog's panel and put `titleId` on its heading.
export function useDialog<T extends HTMLElement = HTMLDivElement>({ onEscape, initialFocusRef }: UseDialogOptions = {}) {
  const dialogRef = useRef<T | null>(null);
  const titleId = useId();
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    const token = Symbol("dialog");
    dialogStack.push(token);
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    if (dialog) {
      const target = initialFocusRef?.current ?? focusableElements(dialog)[0] ?? dialog;
      target.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      const node = dialogRef.current;
      if (!node) return;
      if (e.key === "Escape") {
        if (!onEscapeRef.current) return;
        e.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableElements(node);
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && node.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const index = dialogStack.indexOf(token);
      if (index !== -1) dialogStack.splice(index, 1);
      // Only if focus would otherwise be lost (it was inside the dialog that
      // just went away) -- never pull it back from somewhere the user
      // deliberately moved it, or into an element that's gone from the page.
      const active = document.activeElement;
      const focusLost = active === null || active === document.body;
      if (focusLost && previouslyFocused?.isConnected) previouslyFocused.focus();
    };
    // Mount/unmount only: re-running would re-focus the initial element on
    // every render. initialFocusRef is a ref, read once on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    dialogRef,
    titleId,
    dialogProps: {
      ref: dialogRef,
      role: "dialog" as const,
      "aria-modal": true as const,
      "aria-labelledby": titleId,
      tabIndex: -1,
    },
  };
}
