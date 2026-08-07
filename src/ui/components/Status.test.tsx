import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import Status from "./Status";
import { checkHealth } from "../api";

vi.mock("../api");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("does not poll checkHealth while inactive", async () => {
  vi.mocked(checkHealth).mockResolvedValue(true);
  render(<Status active={false} />);
  await new Promise((r) => setTimeout(r, 0));
  expect(checkHealth).not.toHaveBeenCalled();
});

it("polls checkHealth while active", async () => {
  vi.mocked(checkHealth).mockResolvedValue(true);
  render(<Status active={true} />);
  await new Promise((r) => setTimeout(r, 0));
  expect(checkHealth).toHaveBeenCalledTimes(1);
});
