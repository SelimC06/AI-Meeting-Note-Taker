import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DockedRail from "./DockedRail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SLOT_RECT = { left: 20, top: 5, right: 300, bottom: 45, width: 280, height: 40, x: 20, y: 5, toJSON: () => {} };

const RECORDING_STATUS: RailStatus = {
  status: "recording",
  elapsedLabel: "00:12",
  level: [0.2, 0.5],
  recordError: null,
  isProcessing: false,
  hasPendingUpload: false,
};

function mockSlotRect(rect: DOMRect = SLOT_RECT as DOMRect) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
}

function stubWindowControls(overrides: Record<string, unknown> = {}) {
  const sendRailCommand = vi.fn();
  const beginRailFloatDrag = vi.fn().mockResolvedValue(undefined);
  const railFloatDragMove = vi.fn();
  const endRailFloatDrag = vi.fn().mockResolvedValue(undefined);
  const updateDockSlotRect = vi.fn();
  const getRailFloating = vi.fn().mockResolvedValue(false);
  const getRailStatus = vi.fn().mockResolvedValue(null);
  const reattachRail = vi.fn().mockResolvedValue(undefined);
  let statusCallback: ((status: RailStatus) => void) | undefined;
  let floatingCallback: ((floating: boolean) => void) | undefined;
  const onRailStatus = vi.fn((cb: (status: RailStatus) => void) => {
    statusCallback = cb;
    return () => {};
  });
  const onRailFloating = vi.fn((cb: (floating: boolean) => void) => {
    floatingCallback = cb;
    return () => {};
  });
  vi.stubGlobal("windowControls", {
    onRailStatus,
    getRailStatus,
    sendRailCommand,
    beginRailFloatDrag,
    railFloatDragMove,
    endRailFloatDrag,
    updateDockSlotRect,
    getRailFloating,
    onRailFloating,
    reattachRail,
    ...overrides,
  });
  return {
    sendRailCommand,
    beginRailFloatDrag,
    railFloatDragMove,
    endRailFloatDrag,
    updateDockSlotRect,
    getRailStatus,
    reattachRail,
    emitStatus: (s: RailStatus) => act(() => statusCallback?.(s)),
    emitFloating: (f: boolean) => act(() => floatingCallback?.(f)),
  };
}

it("disables the record button until the first status arrives (brief 12 #4)", () => {
  // Regression test: DEFAULT_STATUS used to be treated as a real status,
  // leaving the button enabled and reading "Start recording" for up to ~1s
  // after mount -- a stray click in that window could stop an actually-live
  // recording.
  stubWindowControls();
  render(<DockedRail />);
  expect(screen.getByLabelText("Start recording")).toBeDisabled();
  expect(screen.getByText("00:00")).toBeInTheDocument();
});

it("enables the record button once a status is pushed", () => {
  const { emitStatus } = stubWindowControls();
  render(<DockedRail />);
  emitStatus({ status: "idle", elapsedLabel: "00:00", level: [], recordError: null, isProcessing: false, hasPendingUpload: false });
  expect(screen.getByLabelText("Start recording")).toBeEnabled();
});

it("seeds status from getRailStatus() on mount when no push has arrived yet (brief 12 #4)", async () => {
  stubWindowControls({ getRailStatus: vi.fn().mockResolvedValue(RECORDING_STATUS) });
  render(<DockedRail />);

  expect(await screen.findByLabelText("Stop recording")).toBeEnabled();
  expect(screen.getByText("00:12")).toBeInTheDocument();
});

it("ignores a stale getRailStatus() pull that resolves after a fresher push already landed", async () => {
  let resolveGetStatus!: (status: RailStatus | null) => void;
  const { emitStatus } = stubWindowControls({
    getRailStatus: vi.fn(() => new Promise<RailStatus | null>((resolve) => (resolveGetStatus = resolve))),
  });
  render(<DockedRail />);

  emitStatus({ status: "paused", elapsedLabel: "00:20", level: [], recordError: null, isProcessing: false, hasPendingUpload: false });
  expect(screen.getByLabelText("Resume recording")).toBeInTheDocument();

  await act(async () => {
    resolveGetStatus(RECORDING_STATUS);
    await Promise.resolve();
  });

  // The stale pull must not clobber the fresher push.
  expect(screen.getByLabelText("Resume recording")).toBeInTheDocument();
});

it("sends toggleRecord when the record button is clicked", () => {
  const { sendRailCommand, emitStatus } = stubWindowControls();
  render(<DockedRail />);
  emitStatus({ status: "idle", elapsedLabel: "00:00", level: [], recordError: null, isProcessing: false, hasPendingUpload: false });
  fireEvent.click(screen.getByLabelText("Start recording"));
  expect(sendRailCommand).toHaveBeenCalledWith("toggleRecord");
});

it("does not throw when a pushed status is missing/malformed fields (brief 12 #2 defense-in-depth)", () => {
  // main.js's own IPC-boundary validation (railValidation.js) is the
  // primary fix, but this checks the render layer doesn't also crash and
  // take the whole sidebar down via its ErrorBoundary if something
  // unsanitized ever gets through.
  const { emitStatus } = stubWindowControls();
  render(<DockedRail />);

  expect(() =>
    emitStatus({ status: "recording" } as unknown as RailStatus)
  ).not.toThrow();
  expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
});

it("reflects a pushed recording status", () => {
  const { emitStatus } = stubWindowControls();
  render(<DockedRail />);
  emitStatus({ status: "recording", elapsedLabel: "00:12", level: [0.2, 0.5], recordError: null, isProcessing: false, hasPendingUpload: false });
  expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
  expect(screen.getByText("00:12")).toBeInTheDocument();
});

it("sends pause while recording and resume while paused", () => {
  const { sendRailCommand, emitStatus } = stubWindowControls();
  render(<DockedRail />);
  emitStatus({ status: "recording", elapsedLabel: "00:05", level: [], recordError: null, isProcessing: false, hasPendingUpload: false });
  fireEvent.click(screen.getByLabelText("Pause recording"));
  expect(sendRailCommand).toHaveBeenCalledWith("pause");

  emitStatus({ status: "paused", elapsedLabel: "00:05", level: [], recordError: null, isProcessing: false, hasPendingUpload: false });
  fireEvent.click(screen.getByLabelText("Resume recording"));
  expect(sendRailCommand).toHaveBeenCalledWith("resume");
});

it("shows the error dot with the message as a tooltip", () => {
  const { emitStatus } = stubWindowControls();
  render(<DockedRail />);
  emitStatus({ status: "idle", elapsedLabel: "00:00", level: [], recordError: "mic unavailable", isProcessing: false, hasPendingUpload: false });
  const dot = screen.getByTitle("mic unavailable");
  expect(dot.className).toContain("bg-red-500");
});

it("disables the record button while the just-stopped recording is uploading, mirroring RailApp's own button", () => {
  const { emitStatus } = stubWindowControls();
  render(<DockedRail />);
  emitStatus({ status: "idle", elapsedLabel: "00:00", level: [], recordError: null, isProcessing: true, hasPendingUpload: false });
  expect(screen.getByLabelText("Start recording")).toBeDisabled();
});

it("renders a drag handle", () => {
  stubWindowControls();
  render(<DockedRail />);
  expect(screen.getByLabelText("Drag to detach the rail")).toBeInTheDocument();
});

it("does not begin a float drag for a movement below the threshold", () => {
  mockSlotRect();
  const { beginRailFloatDrag } = stubWindowControls();
  render(<DockedRail />);
  const handle = screen.getByLabelText("Drag to detach the rail");

  fireEvent.pointerDown(handle, { clientX: 30, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 32, clientY: 21, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 32, clientY: 21, pointerId: 1 });

  expect(beginRailFloatDrag).not.toHaveBeenCalled();
});

it("begins a float drag once the pointer crosses the threshold, sending the dock slot's screen rect", () => {
  mockSlotRect();
  const { beginRailFloatDrag } = stubWindowControls();
  render(<DockedRail />);
  const handle = screen.getByLabelText("Drag to detach the rail");

  fireEvent.pointerDown(handle, { clientX: 30, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 20, pointerId: 1 });

  expect(beginRailFloatDrag).toHaveBeenCalledWith({ x: 20, y: 5, width: 280, height: 40 });
});

it("forwards subsequent pointer moves as drag-move once dragging has begun", () => {
  mockSlotRect();
  const { railFloatDragMove } = stubWindowControls();
  render(<DockedRail />);
  const handle = screen.getByLabelText("Drag to detach the rail");

  fireEvent.pointerDown(handle, { clientX: 30, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 65, clientY: 22, pointerId: 1 });

  expect(railFloatDragMove).toHaveBeenCalledTimes(1);
});

it("throttles rapid-fire drag-move calls instead of sending one per pointermove", () => {
  mockSlotRect();
  const { railFloatDragMove } = stubWindowControls();
  render(<DockedRail />);
  const handle = screen.getByLabelText("Drag to detach the rail");

  fireEvent.pointerDown(handle, { clientX: 30, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 20, pointerId: 1 }); // crosses threshold
  // Fired back-to-back with no real time elapsed — a high-polling-rate
  // device firing far faster than the ~16ms throttle window allows.
  fireEvent.pointerMove(handle, { clientX: 61, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 62, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 63, clientY: 20, pointerId: 1 });

  expect(railFloatDragMove).toHaveBeenCalledTimes(1);
});

it("stays docked when main pushes floating=false after release near the dock slot", () => {
  mockSlotRect();
  const { endRailFloatDrag, emitFloating } = stubWindowControls();
  render(<DockedRail />);
  const handle = screen.getByLabelText("Drag to detach the rail");

  fireEvent.pointerDown(handle, { clientX: 30, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 20, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 40, clientY: 15, pointerId: 1 });
  emitFloating(false);

  expect(endRailFloatDrag).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Start recording")).toBeInTheDocument();
});

it("shows the floating hint when main pushes floating=true after release outside the dock slot", () => {
  mockSlotRect();
  const { endRailFloatDrag, emitFloating } = stubWindowControls();
  render(<DockedRail />);
  const handle = screen.getByLabelText("Drag to detach the rail");

  fireEvent.pointerDown(handle, { clientX: 30, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 20, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 500, clientY: 400, pointerId: 1 });
  emitFloating(true);

  expect(endRailFloatDrag).toHaveBeenCalledTimes(1);
  expect(screen.getByText("[reattach rail]")).toBeInTheDocument();
  expect(screen.queryByLabelText("Start recording")).not.toBeInTheDocument();
});

it("shows the floating hint on mount when getRailFloating resolves true", async () => {
  mockSlotRect();
  stubWindowControls({ getRailFloating: vi.fn().mockResolvedValue(true) });
  render(<DockedRail />);
  expect(await screen.findByText("[reattach rail]")).toBeInTheDocument();
});

it("switches back to the docked pill when onRailFloating pushes false", async () => {
  mockSlotRect();
  const { emitFloating } = stubWindowControls({ getRailFloating: vi.fn().mockResolvedValue(true) });
  render(<DockedRail />);
  await screen.findByText("[reattach rail]");

  emitFloating(false);

  expect(screen.getByLabelText("Start recording")).toBeInTheDocument();
});

it("renders a click-to-reattach button while floating, and calls reattachRail on click", async () => {
  mockSlotRect();
  const { reattachRail } = stubWindowControls({ getRailFloating: vi.fn().mockResolvedValue(true) });
  render(<DockedRail />);

  const reattachButton = await screen.findByRole("button", { name: "[reattach rail]" });
  fireEvent.click(reattachButton);

  expect(reattachRail).toHaveBeenCalledTimes(1);
});

it("keeps the hidden drag placeholder instead of flashing the reattach button or the pill while settling after a drop (brief 12 #3)", () => {
  // Regression test: isDragging clears immediately on pointerUp but
  // isFloating stays true until main's onRailFloating(false) arrives
  // (~160ms later on a successful dock) -- without isSettling, the
  // reattach-button branch flashed for that whole window.
  mockSlotRect();
  const { endRailFloatDrag } = stubWindowControls();
  render(<DockedRail />);
  const handle = screen.getByLabelText("Drag to detach the rail");

  fireEvent.pointerDown(handle, { clientX: 30, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 20, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 40, clientY: 15, pointerId: 1 });

  expect(endRailFloatDrag).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("[reattach rail]")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Start recording")).toBeDisabled();
  // The pill itself must stay invisible too -- showing it here flashed it
  // in the sidebar on every drop that ends up floating (corner/edge snap).
  expect(handle.parentElement).toHaveClass("opacity-0");
});

it("clears the settling state once onRailFloating arrives, resuming normal float/dock rendering", () => {
  mockSlotRect();
  const { emitFloating } = stubWindowControls();
  render(<DockedRail />);
  const handle = screen.getByLabelText("Drag to detach the rail");

  fireEvent.pointerDown(handle, { clientX: 30, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 20, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 500, clientY: 400, pointerId: 1 }); // far from slot -- stays floating

  emitFloating(true);

  expect(screen.getByText("[reattach rail]")).toBeInTheDocument();
});

it("does not report a slot rect while floating and the sidebar is collapsed (brief 12 #1)", async () => {
  mockSlotRect();
  const { updateDockSlotRect } = stubWindowControls({ getRailFloating: vi.fn().mockResolvedValue(true) });
  render(<DockedRail collapsed />);

  await waitFor(() => expect(updateDockSlotRect).toHaveBeenCalled());
  expect(updateDockSlotRect).toHaveBeenLastCalledWith(null);
});

it("reports a fresh rect once the sidebar is expanded again while still floating (brief 12 #1)", async () => {
  mockSlotRect();
  const { updateDockSlotRect } = stubWindowControls({ getRailFloating: vi.fn().mockResolvedValue(true) });
  const { rerender } = render(<DockedRail collapsed />);
  await waitFor(() => expect(updateDockSlotRect).toHaveBeenLastCalledWith(null));

  rerender(<DockedRail collapsed={false} />);

  await waitFor(() =>
    expect(updateDockSlotRect).toHaveBeenLastCalledWith({ x: 20, y: 5, width: 280, height: 40 })
  );
});

it("does not push any slot rect while docked (not floating), regardless of collapsed", () => {
  mockSlotRect();
  const { updateDockSlotRect } = stubWindowControls();
  render(<DockedRail collapsed />);
  expect(updateDockSlotRect).not.toHaveBeenCalled();
});
