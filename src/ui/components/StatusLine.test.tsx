import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import StatusLine from "./StatusLine";
import { checkHealth, getSettings, type Settings } from "../api";

vi.mock("../api");

const settings: Settings = {
  whisper_model: "base.en",
  storage_dir: "C:\\recordings",
  ollama_chat_model: "llama3",
  whisper_model_choices: [],
};

function renderStatusLine(overrides: Partial<ComponentProps<typeof StatusLine>> = {}) {
  return render(
    <StatusLine
      active={false}
      showViewToggle={true}
      view="active"
      onViewChange={vi.fn()}
      {...overrides}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("shows placeholders before any poll resolves", () => {
  vi.mocked(checkHealth).mockReturnValue(new Promise(() => {}));
  vi.mocked(getSettings).mockReturnValue(new Promise(() => {}));
  renderStatusLine();
  expect(screen.getByText(/checking/i)).toBeInTheDocument();
  expect(screen.getByText((content, element) => content.includes("cpu") && element?.textContent?.includes("--"))).toBeInTheDocument();
  expect(screen.getByText((content, element) => content.includes("mem") && element?.textContent?.includes("--"))).toBeInTheDocument();
});

it("shows backend running, cpu/mem, and model names once polled", async () => {
  vi.mocked(checkHealth).mockResolvedValue(true);
  vi.mocked(getSettings).mockResolvedValue(settings);
  vi.stubGlobal("systemAPI", {
    getStats: vi.fn().mockResolvedValue({
      cpuPercent: 12,
      memPercent: 48,
      totalMemBytes: 1,
      freeMemBytes: 1,
    }),
  });

  renderStatusLine({ active: true });

  expect(await screen.findByText(/running/i)).toBeInTheDocument();
  expect(await screen.findByText((content, element) => content.includes("cpu") && element?.textContent?.includes("12%"))).toBeInTheDocument();
  expect(await screen.findByText((content, element) => content.includes("mem") && element?.textContent?.includes("48%"))).toBeInTheDocument();
  expect(await screen.findByText(/base\.en \/ llama3/)).toBeInTheDocument();
});

it("shows stopped when checkHealth resolves false", async () => {
  vi.mocked(checkHealth).mockResolvedValue(false);
  vi.mocked(getSettings).mockResolvedValue(settings);

  renderStatusLine({ active: true });

  expect(await screen.findByText(/stopped/i)).toBeInTheDocument();
});

it("shows active/trash buttons and a divider when showViewToggle is true", () => {
  vi.mocked(checkHealth).mockResolvedValue(true);
  vi.mocked(getSettings).mockResolvedValue(settings);
  renderStatusLine({ showViewToggle: true });

  expect(screen.getByText("[active]")).toBeInTheDocument();
  expect(screen.getByText("[trash]")).toBeInTheDocument();
});

it("hides the active/trash buttons when showViewToggle is false", () => {
  vi.mocked(checkHealth).mockResolvedValue(true);
  vi.mocked(getSettings).mockResolvedValue(settings);
  renderStatusLine({ showViewToggle: false });

  expect(screen.queryByText("[active]")).not.toBeInTheDocument();
  expect(screen.queryByText("[trash]")).not.toBeInTheDocument();
});

it("highlights the currently selected view", () => {
  vi.mocked(checkHealth).mockResolvedValue(true);
  vi.mocked(getSettings).mockResolvedValue(settings);
  renderStatusLine({ view: "trash" });

  expect(screen.getByText("[trash]").className).toContain("bg-signal");
  expect(screen.getByText("[active]").className).not.toContain("bg-signal");
});

it("calls onViewChange when a button is clicked", () => {
  vi.mocked(checkHealth).mockResolvedValue(true);
  vi.mocked(getSettings).mockResolvedValue(settings);
  const onViewChange = vi.fn();
  renderStatusLine({ onViewChange });

  fireEvent.click(screen.getByText("[trash]"));
  expect(onViewChange).toHaveBeenCalledWith("trash");
});
