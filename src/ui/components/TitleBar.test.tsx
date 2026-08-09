import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TitleBar from "./TitleBar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("calls onOpenSettings when the gear icon is clicked", () => {
  vi.stubGlobal("windowControls", {
    minimize: vi.fn(),
    close: vi.fn(),
    getVersion: vi.fn().mockResolvedValue("1.0.0"),
  });
  const onOpenSettings = vi.fn();
  render(<TitleBar onOpenSettings={onOpenSettings} />);

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
});
