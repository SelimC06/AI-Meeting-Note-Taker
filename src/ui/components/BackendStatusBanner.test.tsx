import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import BackendStatusBanner from "./BackendStatusBanner";
import { useBackendLifecycle } from "../hooks/useBackendLifecycle";
import type { BackendLifecycleState } from "../hooks/useBackendLifecycle";

vi.mock("../hooks/useBackendLifecycle");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mockLifecycle(state: BackendLifecycleState) {
  vi.mocked(useBackendLifecycle).mockReturnValue(state);
}

it("renders nothing when healthy", () => {
  mockLifecycle({ phase: "healthy" });
  const { container } = render(<BackendStatusBanner />);
  expect(container.firstChild).toBeNull();
});

it("renders nothing while starting -- Sidebar/Chat's loading states carry the message", () => {
  mockLifecycle({ phase: "starting" });
  const { container } = render(<BackendStatusBanner />);
  expect(container.firstChild).toBeNull();
});

it("shows restart progress while restarting, with no Retry button", () => {
  mockLifecycle({ phase: "restarting", attempt: 2, maxAttempts: 3 });
  render(<BackendStatusBanner />);
  expect(screen.getByText("Backend restarting… (attempt 2/3)")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
});

it("shows a reconnected message", () => {
  mockLifecycle({ phase: "reconnected" });
  render(<BackendStatusBanner />);
  expect(screen.getByText("Backend reconnected")).toBeInTheDocument();
});

it("shows a failed banner with Retry, Open logs and the log tail", async () => {
  mockLifecycle({ phase: "failed", logTail: "Traceback: port in use" });
  const restart = vi.fn().mockResolvedValue(undefined);
  const openLogsFolder = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("backendAPI", { restart });
  vi.stubGlobal("diagnosticsAPI", { openLogsFolder, reportRendererError: vi.fn() });

  render(<BackendStatusBanner />);

  expect(screen.getByRole("alert")).toHaveTextContent("couldn't be restarted");
  expect(screen.queryByText("Traceback: port in use")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("Traceback: port in use")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Open logs" }));
  expect(openLogsFolder).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(restart).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).not.toBeDisabled());
});

it("hides Details and Open logs in the failed banner when there's nothing to show", () => {
  mockLifecycle({ phase: "failed", logTail: "" });
  vi.stubGlobal("backendAPI", { restart: vi.fn() });
  render(<BackendStatusBanner />);
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open logs" })).not.toBeInTheDocument();
});

it("offers Retry when phase is unresponsive (unreachable for >~10s with no main-driven event yet)", () => {
  const restart = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("backendAPI", { onStatus: vi.fn(), restart });
  mockLifecycle({ phase: "unresponsive" });

  render(<BackendStatusBanner />);
  expect(screen.getByText("Backend is not responding.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  expect(restart).toHaveBeenCalledTimes(1);
});
