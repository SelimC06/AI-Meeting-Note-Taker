import { useEffect, useRef, useState } from "react";
import Record from "../../rail/components/Record";
import PauseResume from "../../rail/components/PauseResume";
import LevelMeter from "../../rail/components/LevelMeter";
import { useAnimationReplayKey } from "../../rail/hooks/useAnimationReplayKey";

// The docked pill lives in a ~208px sidebar slot, far narrower than the
// floating rail window it was designed for, so it only renders the most
// recent DOCKED_METER_SAMPLES samples from the shared level history (see
// useMicLevel's HISTORY_LENGTH) instead of the full array.
const DOCKED_METER_SAMPLES = 8;

// Pre-sized to DOCKED_METER_SAMPLES zeros so the meter starts at its real
// width instead of popping in from empty on the first pushed status.
const DEFAULT_STATUS: RailStatus = {
    status: "idle",
    elapsedLabel: "00:00",
    level: Array(DOCKED_METER_SAMPLES).fill(0),
    recordError: null,
    isProcessing: false,
};

// A jitter guard against a plain click being misread as a drag — below
// this many pixels of movement nothing has happened yet (no IPC call, no
// visual change). Once crossed, the floating window takes over completely
// in one step; there is no intermediate CSS-preview phase.
const DRAG_THRESHOLD_PX = 5;

// A high-polling-rate mouse or pen digitizer can fire pointermove hundreds
// of times per second — far more often than the display (or the main
// process's own screen.getCursorScreenPoint() + setBounds calls) can
// usefully act on. Throttling to roughly one frame keeps the drag feeling
// just as live while cutting out redundant IPC/native-call traffic.
const DRAG_MOVE_MIN_INTERVAL_MS = 16;

type DragState = {
    startX: number;
    startY: number;
    slotRect: RailRect;
    crossedThreshold: boolean;
};

export default function DockedRail() {
    const [railStatus, setRailStatus] = useState<RailStatus>(DEFAULT_STATUS);
    const [isFloating, setIsFloating] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    // Bumped every time we (re)become docked — used as the docked pill's
    // `key` below to replay its .rail-pop-in entrance (src/theme.css).
    const [dockGeneration, bumpDockGeneration] = useAnimationReplayKey();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const lastDragMoveSentAtRef = useRef(0);

    useEffect(() => {
        const unsubscribe = window.windowControls?.onRailStatus?.(setRailStatus);
        return unsubscribe;
    }, []);

    useEffect(() => {
        let cancelled = false;
        window.windowControls?.getRailFloating?.()?.then((floating) => {
            if (!cancelled) setIsFloating(!!floating);
        });
        const unsubscribe = window.windowControls?.onRailFloating?.((floating) => setIsFloating(floating));
        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, []);

    // Plays a pop-in entrance on the docked pill every time we (re)become
    // docked — whether that's from dragging it back near the dock slot or
    // clicking the reattach button below. Purely a visual entrance effect;
    // doesn't touch how/when docking actually happens. Skips its own first
    // run: isFloating starts false on mount too, and without this guard
    // the pill would remount (restarting the entrance animation it just
    // started) immediately after every cold launch.
    const isFirstFloatingCheckRef = useRef(true);
    useEffect(() => {
        if (isFirstFloatingCheckRef.current) {
            isFirstFloatingCheckRef.current = false;
            return;
        }
        if (!isFloating) bumpDockGeneration();
    }, [isFloating, bumpDockGeneration]);

    const handleReattachClick = () => {
        window.windowControls?.reattachRail?.()
            ?.catch((err) => console.warn("[DockedRail] reattachRail failed:", err));
    };

    // While floating, keep the main process's cached dock-slot rect fresh —
    // it only knows the rect as of the moment the detach began, and the
    // dashboard window can be resized in the meantime before the user drags
    // the floating rail back.
    useEffect(() => {
        if (!isFloating) return;
        const reportSlotRect = () => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            window.windowControls?.updateDockSlotRect?.({
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
            });
        };
        reportSlotRect();
        window.addEventListener("resize", reportSlotRect);
        // A window 'resize' event misses layout-only changes — e.g. the
        // sidebar collapsing, which is a pure CSS width transition inside a
        // fixed-size dashboard window, not a window resize at all. Without
        // this, dragging the floating rail back after a collapse can try to
        // dock it into a slot rect that's now stale (0-width/invisible).
        let observer: ResizeObserver | undefined;
        if (typeof ResizeObserver !== "undefined" && containerRef.current) {
            observer = new ResizeObserver(reportSlotRect);
            observer.observe(containerRef.current);
        }
        return () => {
            window.removeEventListener("resize", reportSlotRect);
            observer?.disconnect();
        };
    }, [isFloating]);

    const { status, elapsedLabel, level, recordError, isProcessing } = railStatus;
    const isRecording = status === "recording";
    const isPaused = status === "paused";
    const isStarting = status === "starting";

    const sendCommand = (action: RailCommandAction) => {
        window.windowControls?.sendRailCommand?.(action);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // jsdom (the test environment) doesn't implement pointer capture.
        }
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            slotRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            crossedThreshold: false,
        };
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag) return;

        if (!drag.crossedThreshold) {
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            drag.crossedThreshold = true;
            setIsDragging(true);
            window.windowControls?.beginRailFloatDrag?.(drag.slotRect);
            return;
        }

        const now = Date.now();
        if (now - lastDragMoveSentAtRef.current < DRAG_MOVE_MIN_INTERVAL_MS) return;
        lastDragMoveSentAtRef.current = now;
        window.windowControls?.railFloatDragMove?.();
    };

    const handlePointerUp = () => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag?.crossedThreshold) return;

        setIsDragging(false);
        // The dock-vs-float decision is made authoritatively by main (see
        // settleFloatingRailPosition in main.js), which pushes the result
        // via onRailFloating. We don't guess locally here: main's hit-test
        // uses the floating window's actual current bounds, which can
        // disagree with a local guess at the slot boundary, and only main
        // pushing in both directions guarantees the renderer converges.
        window.windowControls?.endRailFloatDrag?.();
    };

    // If the OS cancels the gesture mid-drag (Alt+Tab, Win+L, a display
    // change, or the floating window — alwaysOnTop + focusable — stealing
    // focus), pointerup never fires. Without this, isDragging would stay
    // true forever here, and main's isRailFloatDragging would stay true
    // forever too, permanently disabling the 'moved' listener that drives
    // corner-snap and drag-back-reattach for the rest of the app session.
    const handlePointerCancel = () => {
        handlePointerUp();
    };

    if (isFloating && !isDragging) {
        return (
            <div
                ref={containerRef}
                className="flex h-10 w-full flex-none items-center justify-center rounded-full border border-dashed border-line px-3"
            >
                <button
                    onClick={handleReattachClick}
                    className="text-xs text-dim hover:text-phosphor focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                >
                    [reattach rail]
                </button>
            </div>
        );
    }

    return (
        <div
            key={dockGeneration}
            ref={containerRef}
            className={
                "relative h-10 w-full flex-none rounded-full rail-pop-in " +
                (isDragging ? "border border-dashed border-signal/60" : "")
            }
        >
            <div
                className={
                    "flex h-10 w-full flex-none items-center gap-2 rounded-full border border-signal/40 bg-void px-2 select-none " +
                    (isDragging ? "opacity-0" : "")
                }
            >
                <div
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}
                    onLostPointerCapture={handlePointerCancel}
                    role="button"
                    aria-label="Drag to detach the rail"
                    className="grid h-6 w-3 flex-none cursor-grab place-items-center touch-none"
                >
                    <div className="flex flex-col gap-[3px]">
                        <span className="h-[3px] w-[3px] rounded-full bg-dim" />
                        <span className="h-[3px] w-[3px] rounded-full bg-dim" />
                        <span className="h-[3px] w-[3px] rounded-full bg-dim" />
                    </div>
                </div>

                <Record onClick={() => sendCommand("toggleRecord")} isRecording={isRecording} isStarting={isStarting} disabled={isProcessing || isStarting} />

                <span
                    aria-label="Elapsed recording time"
                    role="timer"
                    className="font-mono text-[11px] tabular-nums text-phosphor"
                >{elapsedLabel}</span>

                <LevelMeter levels={level.slice(-DOCKED_METER_SAMPLES)} active={isRecording} />

                <div className="h-4 w-px flex-none bg-line" />

                <PauseResume
                    status={isPaused ? "paused" : "recording"}
                    onClick={() => sendCommand(isPaused ? "resume" : "pause")}
                    disabled={!isRecording && !isPaused}
                />

                <span
                    title={recordError ?? undefined}
                    className={
                        "ml-auto h-2.5 w-2.5 flex-none rounded-full border border-void transition-colors " +
                        (recordError ? "bg-red-500" : "bg-dim")
                    }
                />
            </div>
        </div>
    );
}
