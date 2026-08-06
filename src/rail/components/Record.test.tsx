import { expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, cleanup } from "@testing-library/react";
import Record from "./Record";

afterEach(cleanup);

it("shows a circle icon and a start label when idle", () => {
  const { getByRole, container } = render(<Record isRecording={false} />);
  expect(getByRole("button", { name: "Start recording" })).toBeInTheDocument();
  expect(container.querySelector("circle")).not.toBeNull();
  expect(container.querySelector("rect")).toBeNull();
});

it("shows a square icon and a stop label when recording", () => {
  const { getByRole, container } = render(<Record isRecording={true} />);
  expect(getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
  expect(container.querySelector("rect")).not.toBeNull();
  expect(container.querySelector("circle")).toBeNull();
});

it("calls onClick when clicked", () => {
  const onClick = vi.fn();
  const { getByRole } = render(<Record isRecording={false} onClick={onClick} />);
  fireEvent.click(getByRole("button"));
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("is disabled when disabled is true", () => {
  const { getByRole } = render(<Record isRecording={false} disabled />);
  expect(getByRole("button")).toBeDisabled();
});
