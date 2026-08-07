import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TitleBar from "./TitleBar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("does not flip the pill's displayed state when neither toggleRail nor getRailState returns a boolean", async () => {
  vi.stubGlobal("windowControls", {
    minimize: vi.fn(),
    close: vi.fn(),
    getVersion: vi.fn().mockResolvedValue("1.0.0"),
    // Neither bridge method resolves to a boolean -- simulates the
    // preload bridge not being ready yet.
    toggleRail: vi.fn().mockResolvedValue(undefined),
    getRailState: vi.fn().mockResolvedValue(undefined),
  });

  render(<TitleBar page="dashboard" onChangePage={() => {}} />);

  const pill = await screen.findByRole("button", { name: "Start" });
  fireEvent.click(pill);

  // handleClick resolves asynchronously; wait a tick for it to finish.
  await new Promise((r) => setTimeout(r, 0));

  expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
});
