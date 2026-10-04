import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import BuiltinModelGate from "./BuiltinModelGate";
import { getBuiltinStatus, getSettings, startBuiltinSetup, type BuiltinStatus, type Settings } from "../api";

vi.mock("../api");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MODEL = { name: "gemma-3-4b-it-Q4_K_M", label: "Gemma 3 4B", size_bytes: 2489757856 };

function mockSettings(ai_provider: Settings["ai_provider"]) {
  vi.mocked(getSettings).mockResolvedValue({ ai_provider } as Settings);
}

function status(partial: Partial<BuiltinStatus>): BuiltinStatus {
  return {
    state: "idle",
    error: null,
    progress: null,
    model: MODEL,
    model_downloaded: false,
    ...partial,
  };
}

it("renders nothing while another provider is selected", async () => {
  mockSettings("ollama");
  vi.mocked(getBuiltinStatus).mockResolvedValue(status({ state: "idle" }));

  const { container } = render(<BuiltinModelGate />);
  // Let the initial settings fetch resolve.
  await vi.waitFor(() => expect(getSettings).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
  // It never even asked for builtin status.
  expect(getBuiltinStatus).not.toHaveBeenCalled();
});

it("offers the one-time download when the model is missing, and starts setup on click", async () => {
  mockSettings("builtin");
  vi.mocked(getBuiltinStatus).mockResolvedValue(status({ state: "idle" }));
  vi.mocked(startBuiltinSetup).mockResolvedValue(
    status({
      state: "downloading",
      progress: { downloaded_bytes: 0, total_bytes: MODEL.size_bytes },
    })
  );

  render(<BuiltinModelGate />);

  const download = await screen.findByRole("button", { name: /download model \(2\.5 GB\)/i });
  // The dialog is labelled and modal, same contract as the Ollama gate.
  expect(screen.getByRole("dialog", { name: "[SETUP]" })).toHaveAttribute("aria-modal", "true");

  fireEvent.click(download);
  expect(await screen.findByRole("progressbar", { name: /model download/i })).toBeInTheDocument();
  expect(startBuiltinSetup).toHaveBeenCalledTimes(1);
});

it("renders download progress with the right percentage", async () => {
  mockSettings("builtin");
  vi.mocked(getBuiltinStatus).mockResolvedValue(
    status({
      state: "downloading",
      progress: { downloaded_bytes: MODEL.size_bytes / 2, total_bytes: MODEL.size_bytes },
    })
  );

  render(<BuiltinModelGate />);

  const bar = await screen.findByRole("progressbar", { name: /model download/i });
  expect(bar).toHaveAttribute("aria-valuenow", "50");
  expect(screen.getByText(/1\.2 \/ 2\.5 GB · 50%/)).toBeInTheDocument();
});

it("shows the backend's error and retries setup from the error state", async () => {
  mockSettings("builtin");
  vi.mocked(getBuiltinStatus).mockResolvedValue(
    status({ state: "error", error: "the local model server exited with code 1" })
  );
  vi.mocked(startBuiltinSetup).mockResolvedValue(status({ state: "starting" }));

  render(<BuiltinModelGate />);

  expect(await screen.findByText(/exited with code 1/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /try again/i }));
  expect(await screen.findByText(/starting the local model/i)).toBeInTheDocument();
  expect(startBuiltinSetup).toHaveBeenCalledTimes(1);
});

it("renders nothing once the server is ready", async () => {
  mockSettings("builtin");
  vi.mocked(getBuiltinStatus).mockResolvedValue(status({ state: "ready", model_downloaded: true }));

  const { container } = render(<BuiltinModelGate />);
  await vi.waitFor(() => expect(getBuiltinStatus).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

it("stays hidden while suppressed (another dialog is open)", async () => {
  mockSettings("builtin");
  vi.mocked(getBuiltinStatus).mockResolvedValue(status({ state: "idle" }));

  const { container } = render(<BuiltinModelGate suppressed />);
  await vi.waitFor(() => expect(getSettings).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

it("can be dismissed with Continue anyway", async () => {
  mockSettings("builtin");
  vi.mocked(getBuiltinStatus).mockResolvedValue(status({ state: "idle" }));

  const { container } = render(<BuiltinModelGate />);
  fireEvent.click(await screen.findByRole("button", { name: /continue anyway/i }));
  expect(container).toBeEmptyDOMElement();
});
