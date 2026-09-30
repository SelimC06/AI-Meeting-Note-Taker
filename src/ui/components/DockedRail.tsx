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
// width instead of popping in from empty on the first pushed status. Purely
// a layout placeholder now -- the Record button stays disabled (see
// hasStatus below) until a real status has actually arrived, so this
// default's "idle" status is never itself actionable.
const DEFAULT_STATUS: RailStatus = {
    status: "idle",
    elapsedLabel: "00:00",
    level: Array(DOCKED_METER_SAMPLES).fill(0),
    recordError: null,
    isProcessing: false,
    hasPendingUpload: false,
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

// Upper bound on waiting for main's dock-vs-float answer after a drag
// (normally a single IPC round trip) before showing the pill anyway.
export const RAIL_SETTLE_TIMEOUT_MS = 1000;

type DragState = {
    startX: number;
    startY: number;
    slotRect: RailRect;
    crossedThreshold: boolean;
};

interface Props {
    // Mirrors Sidebar's collapsed state -- collapsing animates the sidebar's
    // OUTER wrapper to w-0 overflow-hidden while this component's container
    // sits inside the fixed-width INNER column, whose rect never actually
    // changes size. Neither the ResizeObserver nor a window 'resize' event
    // fires, so without this prop the dock-slot-reporting effect below has
    // no way to know the slot just became hidden -- a drop could still dock
    // the rail into an invisible, inert sidebar (brief 12 #1).
    collapsed?: boolean;
}

export default function DockedRail({ collapsed = false }: Props) {
    const [railStatus, setRailStatus] = useState<RailStatus | null>(null);
    const [isFloating, setIsFloating] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    // True from the moment a drag-release is handed off to main (endFloatDrag)
    // until main tells us the outcome (onRailFloating fires either way) --
    // isDragging goes false immediately on release, but isFloating doesn't
    // flip to false until ~160ms after a successful dock (popRailBackToDock's
    // pop-out animation in main.js). Without this, the reattach-button branch
    // below flashed for that whole window before the docked pill popped in
    // (brief 12 #3).
    const [isSettling, setIsSettling] = useState(false);
    // Bumped every time we (re)become docked — used as the docked pill's
    // `key` below to replay its .rail-pop-in entrance (src/theme.css).
    const [dockGeneration, bumpDockGeneration] = useAnimationReplayKey();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const lastDragMoveSentAtRef = useRef(0);
    // Guards the pull (getRailStatus) below against clobbering a more recent
    // push (onRailStatus) that arrived first -- the pull's IPC round-trip
    // can resolve after a status event that landed in the meantime.
    const receivedPushRef = useRef(false);

    useEffect(() => {
        const unsubscribe = window.windowControls?.onRailStatus?.((status) => {
            receivedPushRef.current = true;
            setRailStatus(status);
        });
        return unsubscribe;
    }, []);

    // Pull side of the pull+push handshake: a freshly mounted DockedRail
    // (e.g. after a dashboard reload while a recording is live) has no
    // status until the rail's next push, which can be close to 1s away
    // (RailApp's elapsed-time/level ticks). Without this, the pill sat on
    // DEFAULT_STATUS -- reading "idle" with an enabled Record button -- for
    // that whole window, and one stray click would send toggleRecord and
    // stop the actually-live recording (brief 12 #4).
    useEffect(() => {
        let cancelled = false;
        window.windowControls?.getRailStatus?.().then((status) => {
            if (cancelled || receivedPushRef.current || !status) return;
            setRailStatus(status);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        window.windowControls?.getRailFloating?.()?.then((floating) => {
            if (!cancelled) setIsFloating(!!floating);
        });
        const unsubscribe = window.windowControls?.onRailFloating?.((floating) => {
            setIsFloating(floating);
            setIsSettling(false);
        });
        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, []);

    // Safety net for settling: it normally ends when main's floatingChanged
    // push arrives (one IPC round trip), but if that push never comes the
    // pill stayed opacity-0 for good -- during a recording that hid the
    // dashboard's record/stop controls. After RAIL_SETTLE_TIMEOUT_MS, stop
    // settling and ask main where the rail actually ended up.
    useEffect(() => {
        if (!isSettling) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            setIsSettling(false);
            window.windowControls?.getRailFloating?.()?.then((floating) => {
                if (!cancelled) setIsFloating(!!floating);
            });
        }, RAIL_SETTLE_TIMEOUT_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [isSettling]);

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
    // the floating rail back. Also re-runs on `collapsed` changing: that's
    // a pure CSS width transition on an ANCESTOR of this container (see the
    // Props comment above), which doesn't itself fire the ResizeObserver or
    // a window 'resize' event, so it needs to be handled explicitly rather
    // than relying on either of those to ever notice.
    useEffect(() => {
        if (!isFloating) return;
        const reportSlotRect = () => {
            if (collapsed) {
                window.windowControls?.updateDockSlotRect?.(null);
                return;
            }
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
        // Catches genuine layout changes to THIS container that a window
        // 'resize' event would miss (e.g. the dashboard's own flex layout
        // reflowing for reasons other than a window resize). Collapsing the
        // sidebar is NOT one of these -- see the `collapsed` handling above.
        let observer: ResizeObserver | undefined;
        if (typeof ResizeObserver !== "undefined" && containerRef.current) {
            observer = new ResizeObserver(reportSlotRect);
            observer.observe(containerRef.current);
        }
        return () => {
            window.removeEventListener("resize", reportSlotRect);
            observer?.disconnect();
        };
    }, [isFloating, collapsed]);

    const hasStatus = railStatus !== null;
    const { status, elapsedLabel, level: rawLevel, recordError, isProcessing } = railStatus ?? DEFAULT_STATUS;
    // main.js's rail:pushStatus handler already sanitizes every pushed
    // status (see railValidation.js), but this is a second, cheap defense:
    // a malformed `level` here throwing on .slice() below would otherwise
    // crash this render and take down the whole sidebar via its
    // ErrorBoundary (brief 12 #2).
    const level = Array.isArray(rawLevel) ? rawLevel : [];
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
        setIsSettling(true);
        // The dock-vs-float decision is made authoritatively by main (see
        // settleFloatingRailPosition in main.js), which pushes the result
        // via onRailFloating. We don't guess locally here: main's hit-test
        // uses the floating window's actual current bounds, which can
        // disagree with a local guess at the slot boundary, and only main
        // pushing in both directions guarantees the renderer converges.
        // If the invoke fails, no floatingChanged push is coming -- stop
        // settling now rather than leaving the pill invisible (see the
        // safety timeout below for the push that never arrives).
        Promise.resolve(window.windowControls?.endRailFloatDrag?.()).catch(() => setIsSettling(false));
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

    if (isFloating && !isDragging && !isSettling) {
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

    // Settling keeps the same invisible placeholder as the drag itself until
    // main decides dock vs. float. Showing the pill here instead flashed it
    // for one IPC round-trip on every drop that stays floating (corner/edge
    // snap) before the reattach button replaced it.
    const isPlaceholder = isDragging || isSettling;

    return (
        <div
            key={dockGeneration}
            ref={containerRef}
            className={
                "relative h-10 w-full flex-none rounded-full rail-pop-in " +
                (isPlaceholder ? "border border-dashed border-signal/60" : "")
            }
        >
            <div
                className={
                    "flex h-10 w-full flex-none items-center gap-2 rounded-full border border-signal/40 bg-void px-2 select-none " +
                    (isPlaceholder ? "opacity-0" : "")
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

                <Record
                    onClick={() => sendCommand("toggleRecord")}
                    isRecording={isRecording}
                    isStarting={isStarting}
                    disabled={isProcessing || isStarting || isSettling || !hasStatus}
                />

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
                    disabled={(!isRecording && !isPaused) || isSettling}
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
