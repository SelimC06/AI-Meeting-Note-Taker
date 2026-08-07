import { expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, cleanup } from "@testing-library/react";
import PauseResume from "./PauseResume";

afterEach(cleanup);

it("shows a pause glyph and label while recording", () => {
  const { getByRole } = render(<PauseResume status="recording" />);
  expect(getByRole("button", { name: "Pause recording" })).toBeInTheDocument();
});

it("shows a play glyph and label while paused", () => {
  const { getByRole, container } = render(<PauseResume status="paused" />);
  expect(getByRole("button", { name: "Resume recording" })).toBeInTheDocument();
  expect(container.querySelector("path")).not.toBeNull();
});

it("calls onClick when enabled and clicked", () => {
  const onClick = vi.fn();
  const { getByRole } = render(<PauseResume status="recording" onClick={onClick} />);
  fireEvent.click(getByRole("button"));
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("does not call onClick when disabled", () => {
  const onClick = vi.fn();
  const { getByRole } = render(<PauseResume status="recording" onClick={onClick} disabled />);
  fireEvent.click(getByRole("button"));
  expect(onClick).not.toHaveBeenCalled();
  expect(getByRole("button")).toBeDisabled();
});

it("has a solid amber fill while recording (pause available)", () => {
  const { getByRole } = render(<PauseResume status="recording" />);
  expect(getByRole("button").className).toContain("bg-amber-500");
});

it("has a solid, slightly lighter amber fill while paused (resume available)", () => {
  const { getByRole } = render(<PauseResume status="paused" />);
  expect(getByRole("button").className).toContain("bg-amber-400");
});
