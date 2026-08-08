import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import StatusLine from "./StatusLine";
import { checkHealth, getSettings, type Settings } from "../api";

vi.mock("../api");

const settings: Settings = {
  whisper_model: "base.en",
  storage_dir: "C:\\recordings",
  ollama_chat_model: "llama3",
  whisper_model_choices: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("shows placeholders before any poll resolves", () => {
  vi.mocked(checkHealth).mockReturnValue(new Promise(() => {}));
  vi.mocked(getSettings).mockReturnValue(new Promise(() => {}));
  render(<StatusLine active={false} />);
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

  render(<StatusLine active={true} />);

  expect(await screen.findByText(/online/i)).toBeInTheDocument();
  expect(await screen.findByText((content, element) => content.includes("cpu") && element?.textContent?.includes("12%"))).toBeInTheDocument();
  expect(await screen.findByText((content, element) => content.includes("mem") && element?.textContent?.includes("48%"))).toBeInTheDocument();
  expect(await screen.findByText(/base\.en \/ llama3/)).toBeInTheDocument();
});

it("shows offline when checkHealth resolves false", async () => {
  vi.mocked(checkHealth).mockResolvedValue(false);
  vi.mocked(getSettings).mockResolvedValue(settings);

  render(<StatusLine active={true} />);

  expect(await screen.findByText(/offline/i)).toBeInTheDocument();
});
