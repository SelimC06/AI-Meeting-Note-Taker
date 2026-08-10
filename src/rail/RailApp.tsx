import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import './rail.css';
import Record from "./components/Record";
import PauseResume from "./components/PauseResume";
import LevelMeter from "./components/LevelMeter";
import ErrorToast from "./components/ErrorToast";
import { useThreeTrackSegments, type ClassifiedError } from './hooks/useThreeTrackSegments';
import { useElapsedTime } from './hooks/useElapsedTime';
import { useMicLevel } from './hooks/useMicLevel';
import { useAnimationReplayKey } from './hooks/useAnimationReplayKey';
import { startProcessing } from "../ui/api";
import { useProcessingJobs } from "../ui/hooks/useProcessingJobs";

const STAGE_LABELS: Record<string, string> = {
  queued: "queued",
  muxing: "combining audio & video",
  transcribing: "transcribing",
  summarizing: "summarizing",
  saving: "saving",
};

export default function RailApp() {
    const { status, record, pause, resume, stop, error: recordError, micStream } = useThreeTrackSegments();
    const { jobs, addJob, removeJob } = useProcessingJobs();

    const [resultFlash, setResultFlash] = useState<"success" | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processError, setProcessError] = useState<string | null>(null);
    const [toastDismissed, setToastDismissed] = useState(false);

    const elapsed = useElapsedTime(status);
    const levels = useMicLevel(micStream);

    useEffect(() => {
        if (resultFlash === null) return;
        const timer = setTimeout(() => setResultFlash(null), 2000);
        return () => clearTimeout(timer);
    }, [resultFlash]);

    useEffect(() => {
        const finished = jobs.find((j) => j.status === "done");
        if (finished) {
            setResultFlash("success");
            removeJob(finished.id);
            return;
        }
        const failed = jobs.find((j) => j.status === "failed");
        if (failed) {
            setProcessError(failed.error ?? "Processing failed.");
            removeJob(failed.id);
        }
    }, [jobs, removeJob]);

    const isRecording = status === "recording";
    const isPaused = status === "paused";
    const isStarting = status === "starting";
    const displayError = useMemo<ClassifiedError | null>(
        () => recordError ?? (processError ? { kind: "generic", message: processError } : null),
        [recordError, processError]
    );

    const hasActiveJobs = jobs.some((j) => j.status === "queued" || j.status === "running");
    const jobStatusTitle =
        jobs.length === 1
            ? `Processing: ${STAGE_LABELS[jobs[0].stage ?? "queued"]}`
            : jobs.length > 1
            ? `${jobs.length} recordings processing`
            : undefined;

    const previousErrorRef = useRef<ClassifiedError | null>(null);
    useEffect(() => {
        if (displayError !== null && displayError !== previousErrorRef.current) {
            setToastDismissed(false);
        }
        previousErrorRef.current = displayError;
    }, [displayError]);

    // Tracks the currently-running upload (initial or a manual retry), if
    // any, so handleStopForClose (below) can wait for it instead of either
    // starting a second one or acking immediately while it's still in
    // flight -- a close/quit arriving in that window used to slip past the
    // guard entirely and kill the rail window (and the in-flight POST
    // /process with it) mid-upload.
    const inFlightUploadRef = useRef<Promise<void> | null>(null);

    // Holds the FormData (and its Blobs) from the most recent failed
    // upload, so "retry upload" can re-POST the exact same recording
    // instead of it being lost. Blobs are immutable and safely re-readable
    // across multiple fetch calls, so the same FormData object can just be
    // resent as-is. Cleared on a successful upload (initial or retried).
    const pendingUploadRef = useRef<FormData | null>(null);

    // Runs `fn` while inFlightUploadRef reflects it for fn's ENTIRE
    // duration -- assigned synchronously, before fn() does anything async,
    // not after some earlier await inside it. This restores the pattern
    // from commit 2645240 (F1): the retry rework had regressed it by only
    // setting inFlightUploadRef inside runUpload itself, which stopAndUpload
    // doesn't reach until AFTER its own `await stop()` has already resolved.
    // A stopForClose arriving during that recorder-flush window used to see
    // inFlightUploadRef still null AND status still "recording"/"paused"/
    // "starting" (stop() hasn't resolved yet) -- falling through both of
    // handleStopForClose's early-return checks and calling stopAndUpload a
    // SECOND time concurrently, producing a truncated duplicate upload.
    // Calling fn() and assigning the ref happen synchronously here, so
    // nothing else can run (this is single-threaded JS) until at least the
    // first await inside fn -- any concurrent check of inFlightUploadRef
    // always sees it already set.
    function trackInFlight(fn: () => Promise<void>): Promise<void> {
        const promise = fn();
        inFlightUploadRef.current = promise;
        return promise.finally(() => {
            if (inFlightUploadRef.current === promise) {
                inFlightUploadRef.current = null;
            }
        });
    }

    // POSTs formData to /process. Callers are responsible for tracking this
    // via trackInFlight themselves (stopAndUpload wraps its whole
    // stop()+upload span; handleRetryUpload/handleRetryUploadForClose wrap
    // just this call) -- see trackInFlight above for why the assignment
    // can't live in here.
    const runUpload = async (formData: FormData) => {
        setIsProcessing(true);
        try {
            let result: { job_id: string; session_id: string };
            try {
                result = await startProcessing(formData);
            } catch (networkErr) {
                if (networkErr instanceof TypeError) {
                    throw new Error("Couldn't reach the app backend — is it running?");
                }
                throw networkErr;
            }

            pendingUploadRef.current = null;
            setProcessError(null);
            addJob(result.job_id);
        } catch (err) {
            console.error("/process failed", err);
            // Keep the FormData around instead of discarding it -- the
            // recording it holds is otherwise unrecoverable.
            pendingUploadRef.current = formData;
            setProcessError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsProcessing(false);
        }
    };

    // Stops the current recording and uploads it. Acked unconditionally on
    // every exit (empty segments, success, or failure) so main.js's guarded
    // close/quit flow — which triggers this via a "stopForClose"
    // rail:command and awaits the ack — never hangs waiting for one that
    // was never coming. See stopAndSaveRailRecording() in main.js.
    const stopAndUpload = () =>
        trackInFlight(async () => {
            try {
                const blobs = await stop();

                // A recording that produced no segments (or a stop that
                // landed while still "starting") resolves stop() to an
                // empty Combined -- nothing to upload, so skip the POST
                // instead of sending an empty FormData.
                if (!blobs.screen && !blobs.systemAudio && !blobs.micAudio) {
                    return;
                }

                const formData = new FormData();
                if (blobs.screen) {
                    formData.append("screen", blobs.screen, "screen.webm");
                }
                if (blobs.systemAudio) {
                    formData.append("system", blobs.systemAudio, "system.webm");
                }
                if (blobs.micAudio) {
                    formData.append("mic", blobs.micAudio, "mic.webm");
                }

                await runUpload(formData);
            } finally {
                window.windowControls?.notifyStopAndSaveComplete?.();
            }
        });

    // Re-POSTs the FormData from the most recent failed upload. Fire-and-
    // forget from the caller's perspective (ErrorToast's action.onClick is
    // synchronous) -- trackInFlight covers it via inFlightUploadRef the same
    // as any other upload. Acks on its own once settled, same as
    // stopAndUpload does, so a close/quit that arrives while a retry is
    // mid-flight (handleStopForClose's inFlightUploadRef wait below) isn't
    // left waiting on an ack nothing would otherwise ever send.
    const handleRetryUpload = () => {
        const formData = pendingUploadRef.current;
        // inFlightUploadRef, not isProcessing: same stale-state hole
        // handleRecordClick's guard closes -- trackInFlight sets the ref
        // synchronously, React state a render later.
        if (!formData || inFlightUploadRef.current) return;
        void trackInFlight(async () => {
            try {
                await runUpload(formData);
            } finally {
                window.windowControls?.notifyStopAndSaveComplete?.();
            }
        });
    };

    // True only while there's a distinct, currently-displayed upload error
    // with a FormData still held for it -- not while a permission-denied
    // recordError (a different failure entirely, nothing to re-upload) is
    // what's actually showing.
    const canRetryUpload = !recordError && processError !== null && pendingUploadRef.current !== null;

    const handleRecordClick = async () => {
        if (isProcessing) return;

        try {
            if (status === "idle") {
                setProcessError(null);
                await record();
            } else if (status === "recording" || status === "paused" || status === "starting") {
                // A stop+upload span is already running (double-click landed in the
                // recorder-flush window) -- layers below make stop() re-entrant, but
                // without this check the same Combined would be uploaded twice.
                if (inFlightUploadRef.current) return;
                await stopAndUpload();
            }
        } catch (err) {
            console.error("record/stop error", err);
            setProcessError(err instanceof Error ? err.message : String(err));
        }
    };

    // Handles main.js's "retryUploadForClose" rail:command (see
    // retryRailUploadAndWait() there), sent when the user picks "Retry and
    // wait" on the pending-upload close dialog (G3). Acks unconditionally on
    // every exit for the same reason stopAndUpload does: main awaits this
    // ack before destroying the rail window, and must never hang on one that
    // was never coming. Deliberately doesn't ack after an already-in-flight
    // upload (the first branch) -- that operation (stopAndUpload or a
    // manually-clicked retry) already guarantees its own single ack once it
    // settles, so acking again here would double-ack.
    const handleRetryUploadForClose = async () => {
        if (inFlightUploadRef.current) {
            try {
                await inFlightUploadRef.current;
            } catch {
                // runUpload already reports its own errors via setProcessError.
            }
            return;
        }
        const formData = pendingUploadRef.current;
        if (!formData) {
            // Nothing pending -- either it never failed, or it already
            // resolved (succeeded/discarded) by the time this arrived.
            window.windowControls?.notifyStopAndSaveComplete?.();
            return;
        }
        try {
            await trackInFlight(() => runUpload(formData));
        } finally {
            window.windowControls?.notifyStopAndSaveComplete?.();
        }
    };

    // Handles main.js's "stopForClose" rail:command (see
    // stopAndSaveRailRecording() there) -- deliberately NOT routed through
    // handleRecordClick's status==="idle" branch, since that would start a
    // brand-new recording if main's cached rail status is stale (already
    // idle here, but main hasn't heard about it yet over the rail:pushStatus
    // round-trip).
    const handleStopForClose = async () => {
        if (inFlightUploadRef.current) {
            // Something -- a manual stop's own upload, or the user clicking
            // "retry upload" on a previously failed one -- already kicked
            // off an upload and it's mid-flight. Wait for that same
            // operation instead of starting a new one or acking
            // immediately, or the close would destroy this window (and the
            // in-flight POST /process with it) mid-upload. Whichever flow
            // started it (stopAndUpload or handleRetryUpload) already
            // guarantees its own single ack once it settles, so there's
            // nothing further to do here either way.
            try {
                await inFlightUploadRef.current;
            } catch {
                // runUpload already reports its own errors via setProcessError.
            }
            return;
        }
        if (status !== "recording" && status !== "paused" && status !== "starting") {
            // Nothing recording and nothing uploading -- ack immediately
            // instead of hanging main's guarded close on an ack that was
            // never coming.
            window.windowControls?.notifyStopAndSaveComplete?.();
            return;
        }
        try {
            await stopAndUpload();
        } catch (err) {
            console.error("stopForClose error", err);
            setProcessError(err instanceof Error ? err.message : String(err));
        }
    };

    const handlePauseClick = async () => {
        if (status === "recording") {
            await pause();
        }
    };

    const handlePlayClick = async () => {
        if (status === "paused") {
            await resume();
        }
    };

    const handleDismissError = useCallback(() => {
        setToastDismissed(true);
    }, []);

    useEffect(() => {
        window.windowControls?.pushRailStatus?.({
            status,
            elapsedLabel: elapsed,
            level: levels,
            recordError: displayError?.message ?? null,
            isProcessing,
            hasPendingUpload: pendingUploadRef.current !== null,
        });
        // pendingUploadRef itself isn't reactive, but every place that
        // mutates it (runUpload's success/failure branches) also calls
        // setProcessError in the same synchronous block, so displayError
        // changing is a reliable proxy for "re-read the ref" -- same
        // pattern canRetryUpload above already relies on.
    }, [status, elapsed, levels, displayError, isProcessing]);

    const commandHandlersRef = useRef({
        handleRecordClick,
        handlePauseClick,
        handlePlayClick,
        handleStopForClose,
        handleRetryUploadForClose,
    });
    commandHandlersRef.current = {
        handleRecordClick,
        handlePauseClick,
        handlePlayClick,
        handleStopForClose,
        handleRetryUploadForClose,
    };

    useEffect(() => {
        const unsubscribe = window.windowControls?.onRailCommand?.((action) => {
            if (action === "toggleRecord") commandHandlersRef.current.handleRecordClick();
            else if (action === "pause") commandHandlersRef.current.handlePauseClick();
            else if (action === "resume") commandHandlersRef.current.handlePlayClick();
            else if (action === "stopForClose") commandHandlersRef.current.handleStopForClose();
            else if (action === "retryUploadForClose") commandHandlersRef.current.handleRetryUploadForClose();
        });
        return unsubscribe;
    }, []);

    // "Popped" plays the .rail-pop-out CSS animation (src/theme.css) — how
    // the floating rail signals it's about to be hidden, whether that's a
    // click-to-reattach or a drag released near the dock slot (main.js's
    // popRailBackToDock drives both the same way) — driven by main.js via
    // 'rail:popState' so the visible animation and the actual
    // hide/floatingChanged timing stay in sync. The renderer isn't reloaded
    // between hide/show, so this must also be reset explicitly
    // (popped: false) the next time the rail floats again (see main.js's
    // rail:beginFloatDrag), or it would silently stay faded out.
    //
    // That same "popped: false" reset doubles as the entrance cue: bumping
    // floatGeneration remounts the pill's DOM node, so .rail-pop-in replays
    // fresh every time a drag detaches the rail, instead of it just
    // snapping into view at full opacity.
    const [popped, setPopped] = useState(false);
    const [floatGeneration, bumpFloatGeneration] = useAnimationReplayKey();
    useEffect(() => {
        const unsubscribe = window.windowControls?.onRailPopState?.((payload) => {
            const nextPopped = !!payload?.popped;
            setPopped(nextPopped);
            if (!nextPopped) bumpFloatGeneration();
        });
        return unsubscribe;
    }, [bumpFloatGeneration]);

    return (
        <div className="flex h-full w-full flex-col items-center gap-2">
            <div
                key={floatGeneration}
                className={
                    "flex h-10 w-full flex-none items-center gap-3 rounded-full border border-signal/40 bg-void px-3 select-none [-webkit-app-region:drag] " +
                    (popped ? "rail-pop-out" : "rail-pop-in")
                }
            >
                <div className="[-webkit-app-region:no-drag]">
                    <Record onClick={handleRecordClick} isRecording={isRecording} isStarting={isStarting} disabled={isProcessing || isStarting}/>
                </div>

                <span
                    aria-label="Elapsed recording time"
                    role="timer"
                    className="font-mono text-[11px] tabular-nums text-phosphor"
                >{elapsed}</span>

                <LevelMeter levels={levels} active={isRecording} />

                <div className="h-4 w-px flex-none bg-line" />

                <div className="[-webkit-app-region:no-drag]">
                    <PauseResume
                        status={isPaused ? "paused" : "recording"}
                        onClick={isPaused ? handlePlayClick : handlePauseClick}
                        disabled={!isRecording && !isPaused}
                    />
                </div>

                <span
                    title={isProcessing ? "Uploading recording…" : displayError?.message ?? jobStatusTitle}
                    className={
                        "ml-auto h-2.5 w-2.5 flex-none rounded-full border border-void transition-colors " +
                        (isProcessing || hasActiveJobs
                            ? "bg-amber-400 animate-pulse"
                            : displayError
                            ? "bg-red-500"
                            : resultFlash === "success"
                            ? "bg-signal"
                            : "bg-dim")
                    }
                />
            </div>
            <ErrorToast
                message={toastDismissed ? null : displayError?.message ?? null}
                onDismiss={handleDismissError}
                action={
                    !toastDismissed && canRetryUpload
                        ? { label: "retry upload", onClick: handleRetryUpload }
                        : !toastDismissed && displayError?.kind === "permission-denied"
                        ? { label: "open privacy settings", onClick: () => window.settingsAPI?.openPrivacySettings?.("microphone") }
                        : undefined
                }
            />
        </div>
    )
}
