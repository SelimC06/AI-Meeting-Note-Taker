import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import './rail.css';
import Record from "./components/Record";
import PauseResume from "./components/PauseResume";
import LevelMeter from "./components/LevelMeter";
import ErrorToast from "./components/ErrorToast";
import { useThreeTrackSegments, type ClassifiedError } from './hooks/useThreeTrackSegments';
import { extensionForMimeType } from './capture/recorder';
import { useElapsedTime } from './hooks/useElapsedTime';
import { useMicLevel } from './hooks/useMicLevel';
import { useAnimationReplayKey } from './hooks/useAnimationReplayKey';
import { useThrottledValue } from './hooks/useThrottledValue';
import { startProcessing } from "../ui/api";
import { useProcessingJobs } from "../ui/hooks/useProcessingJobs";

const STAGE_LABELS: Record<string, string> = {
  queued: "queued",
  muxing: "combining audio & video",
  transcribing: "transcribing",
  summarizing: "summarizing",
  saving: "saving",
};

// ~5 updates a second for the dashboard's docked level meter: smooth
// enough to read as live, a third of the raw ~60ms level cadence.
export const RAIL_LEVEL_PUSH_INTERVAL_MS = 200;

export default function RailApp() {
    const { status, record, pause, resume, stop, error: recordError, micStream, systemStream } = useThreeTrackSegments();
    const { jobs, addJob, removeJob } = useProcessingJobs();

    const [resultFlash, setResultFlash] = useState<"success" | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processError, setProcessError] = useState<string | null>(null);
    // Kept apart from processError on purpose: processError is transient
    // (a failed job, a stop() that threw) and is cleared when a new
    // recording starts, but an upload failure means a recording that exists
    // nowhere except this renderer's memory -- its message has to stay up
    // for as long as pendingUploadsRef still holds it, however many
    // recordings come after.
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [pendingUploadCount, setPendingUploadCount] = useState(0);
    // True from the first click on Record until record() settles, including
    // the wait on the first-run consent modal (status is still "idle"
    // throughout that wait) -- drives the button's disabled state.
    const [isStartPending, setIsStartPending] = useState(false);
    const [toastDismissed, setToastDismissed] = useState(false);

    const elapsed = useElapsedTime(status);
    const levels = useMicLevel(micStream, systemStream);
    // The rail's own LevelMeter animates from `levels` directly (every
    // ~60ms), but the copy pushed to main for the dashboard's DockedRail is
    // throttled: each push is an IPC round trip plus a DockedRail re-render
    // in the other window, and at the raw rate that was ~16 a second for as
    // long as a recording ran -- even while the dashboard was hidden.
    const pushedLevels = useThrottledValue(levels, RAIL_LEVEL_PUSH_INTERVAL_MS);

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
    const uploadErrorMessage =
        pendingUploadCount === 0
            ? null
            : pendingUploadCount === 1
            ? uploadError
            : `${pendingUploadCount} recordings failed to upload: ${uploadError}`;
    // A pending upload outranks processError: the latter is informational,
    // the former is the only thing standing between the user and losing a
    // recording, and hiding it behind e.g. a later job failure would also
    // hide its retry action.
    const displayError = useMemo<ClassifiedError | null>(
        () =>
            recordError ??
            (uploadErrorMessage
                ? { kind: "generic", message: uploadErrorMessage }
                : processError
                ? { kind: "generic", message: processError }
                : null),
        [recordError, uploadErrorMessage, processError]
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
    //
    // `kind` says who acks main's close/quit handoff for it: a "stop"
    // (stopAndUpload) always acks once it settles; a "retry" (the toast's /
    // docked pill's "retry upload") never does -- it can run while a NEW
    // recording is live, and its ack used to let a quit destroy the window
    // with that recording still in it (handleStopForClose now waits for
    // the retry and then stops the live recording itself).
    const inFlightUploadRef = useRef<{ promise: Promise<void>; kind: "stop" | "retry" } | null>(null);

    // Mirrors `status` for code that reads it after an await -- the closure's
    // copy is from before the wait (see handleStopForClose).
    const statusRef = useRef(status);
    statusRef.current = status;

    // Uploads in flight (a stop's and a retry's can overlap), so isProcessing
    // only clears when the last one settles.
    const activeUploadsRef = useRef(0);

    // Every recording whose upload has failed and not yet succeeded on a
    // retry, oldest first, so "retry upload" can re-POST the exact same
    // recordings instead of them being lost. Blobs are immutable and safely
    // re-readable across multiple fetch calls, so each FormData can just be
    // resent as-is. A queue rather than a single slot: with one slot, a
    // second recording's upload -- succeeding (clearing the slot) or failing
    // (overwriting it) -- silently discarded the first. An entry leaves only
    // when its own upload succeeds. pendingUploadCount mirrors its length
    // for rendering.
    const pendingUploadsRef = useRef<FormData[]>([]);

    // Acks main.js's close/quit handoff (see waitForStopAck there) with the
    // pending-upload state as of RIGHT NOW, read from the ref -- never from
    // pendingUploadCount/React state, and not left to the rail:pushStatus
    // effect below either: both only catch up a re-render later, after main
    // has already acted on this ack. A stop-for-close whose upload just
    // failed would otherwise look to main like "nothing pending" and the
    // close would destroy that recording without offering Retry/Discard.
    const ackStopAndSave = () => {
        window.windowControls?.notifyStopAndSaveComplete?.({
            hasPendingUpload: pendingUploadsRef.current.length > 0,
        });
    };

    // Synchronous companion to isStartPending: set before handleRecordClick's
    // first await so a second click (or a toggleRecord command) in the same
    // tick, or while the consent modal is up, sees it immediately instead of
    // a stale status==="idle" and starting a second, concurrent recording.
    const startingRef = useRef(false);

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
    function trackInFlight(kind: "stop" | "retry", fn: () => Promise<void>): Promise<void> {
        const promise = fn();
        const entry = { promise, kind };
        inFlightUploadRef.current = entry;
        return promise.finally(() => {
            if (inFlightUploadRef.current === entry) {
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
        activeUploadsRef.current += 1;
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

            // Removes only this recording -- any other still-pending ones stay
            // queued (and their error stays up) until they succeed too.
            pendingUploadsRef.current = pendingUploadsRef.current.filter((f) => f !== formData);
            setPendingUploadCount(pendingUploadsRef.current.length);
            addJob(result.job_id);
        } catch (err) {
            console.error("/process failed", err);
            // Keep the FormData around instead of discarding it -- the
            // recording it holds is otherwise unrecoverable. A retry that
            // fails again keeps its existing place in the queue.
            if (!pendingUploadsRef.current.includes(formData)) {
                pendingUploadsRef.current = [...pendingUploadsRef.current, formData];
            }
            setPendingUploadCount(pendingUploadsRef.current.length);
            setUploadError(err instanceof Error ? err.message : String(err));
        } finally {
            activeUploadsRef.current -= 1;
            if (activeUploadsRef.current === 0) setIsProcessing(false);
        }
    };

    // Stops the current recording and uploads it. Acked unconditionally on
    // every exit (empty segments, success, or failure) so main.js's guarded
    // close/quit flow — which triggers this via a "stopForClose"
    // rail:command and awaits the ack — never hangs waiting for one that
    // was never coming. See stopAndSaveRailRecording() in main.js.
    const stopAndUpload = () =>
        trackInFlight("stop", async () => {
            try {
                const blobs = await stop();

                // A recording that produced no segments (or a stop that
                // landed while still "starting") resolves stop() to an
                // empty Combined -- nothing to upload, so skip the POST
                // instead of sending an empty FormData.
                if (!blobs.screen && !blobs.systemAudio && !blobs.micAudio) {
                    return;
                }

                // Extensions follow each blob's real container (an audio
                // track can be ogg -- see extensionForMimeType). The backend
                // stores by field name and ffprobes the content, so the
                // filename here is descriptive, not load-bearing.
                const formData = new FormData();
                if (blobs.screen) {
                    formData.append("screen", blobs.screen, `screen.${extensionForMimeType(blobs.screen.type)}`);
                }
                if (blobs.systemAudio) {
                    formData.append("system", blobs.systemAudio, `system.${extensionForMimeType(blobs.systemAudio.type)}`);
                }
                if (blobs.micAudio) {
                    formData.append("mic", blobs.micAudio, `mic.${extensionForMimeType(blobs.micAudio.type)}`);
                }

                await runUpload(formData);
            } finally {
                ackStopAndSave();
            }
        });

    // Re-POSTs every queued upload, oldest first, one at a time (each is
    // a full recording -- no point competing for the same backend). Works
    // on a snapshot: runUpload edits the queue as each one settles.
    const retryPendingUploads = async () => {
        for (const formData of [...pendingUploadsRef.current]) {
            await runUpload(formData);
        }
    };

    // Re-POSTs every failed upload still queued. Fire-and-forget from the
    // caller's perspective (ErrorToast's action.onClick is synchronous, and
    // the docked pill's "retry upload" arrives as a rail:command) --
    // trackInFlight covers it via inFlightUploadRef the same as any other
    // upload. Deliberately does NOT ack main's close/quit handoff: a close
    // arriving meanwhile is handled by handleStopForClose /
    // handleRetryUploadForClose, which wait for this and then ack exactly
    // once themselves.
    const handleRetryUpload = () => {
        // inFlightUploadRef, not isProcessing: same stale-state hole
        // handleRecordClick's guard closes -- trackInFlight sets the ref
        // synchronously, React state a render later.
        if (pendingUploadsRef.current.length === 0 || inFlightUploadRef.current) return;
        void trackInFlight("retry", retryPendingUploads);
    };

    // True only while the upload error is what's actually showing -- not
    // while a permission-denied recordError (a different failure entirely,
    // nothing to re-upload) is.
    const canRetryUpload = !recordError && pendingUploadCount > 0;

    const handleRecordClick = async () => {
        try {
            if (status === "idle") {
                // Only STARTING is held back by an upload in flight -- a
                // retry upload used to block Stop too, for as long as the
                // (possibly multi-minute) upload took.
                if (isProcessing) return;
                // Checked and set before the first await -- see startingRef.
                if (startingRef.current) return;
                startingRef.current = true;
                setIsStartPending(true);
                try {
                    // Resolves immediately (true) every time after the first --
                    // only the very first call in the app's lifetime actually
                    // shows anything, in the dashboard window, and waits on it.
                    const canRecord = await window.consentAPI?.ensureRecordingConsent?.() ?? true;
                    if (!canRecord) return;
                    // Clears only transient errors -- a failed upload's
                    // message (uploadError) stays until it's retried.
                    setProcessError(null);
                    await record();
                } finally {
                    startingRef.current = false;
                    setIsStartPending(false);
                }
            } else if (status === "recording" || status === "paused" || status === "starting") {
                // A stop+upload span is already running (double-click landed in the
                // recorder-flush window) -- layers below make stop() re-entrant, but
                // without this check the same Combined would be uploaded twice.
                // A RETRY in flight doesn't block this: it's re-sending older
                // recordings, and this live one still has to be stopped.
                if (inFlightUploadRef.current?.kind === "stop") return;
                await stopAndUpload();
            }
        } catch (err) {
            console.error("record/stop error", err);
            setProcessError(err instanceof Error ? err.message : String(err));
        }
    };

    // Settles `promise` without throwing -- runUpload already reports its
    // own errors via setUploadError.
    const settled = (promise: Promise<void>) => promise.catch(() => {});

    // Handles main.js's "retryUploadForClose" rail:command (see
    // retryRailUploadAndWait() there), sent when the user picks "Retry and
    // wait" on the pending-upload close dialog (G3). Acks exactly once on
    // every exit for the same reason stopAndUpload does: main awaits this
    // ack before destroying the rail window, and must never hang on one that
    // was never coming -- except after an in-flight STOP, which acks itself.
    const handleRetryUploadForClose = async () => {
        // Only awaited when something IS in flight: with nothing running,
        // the retry below must start in this same tick (trackInFlight sets
        // the ref synchronously) so a "retry upload" click racing this
        // command sees it and doesn't POST the same recording twice.
        const inFlight = inFlightUploadRef.current;
        if (inFlight) {
            await settled(inFlight.promise);
            if (inFlight.kind === "stop") return; // it acked for itself
        }
        try {
            if (pendingUploadsRef.current.length > 0) {
                await trackInFlight("retry", retryPendingUploads);
            }
        } finally {
            ackStopAndSave();
        }
    };

    // Handles main.js's "stopForClose" rail:command (see
    // stopAndSaveRailRecording() there) -- deliberately NOT routed through
    // handleRecordClick's status==="idle" branch, since that would start a
    // brand-new recording if main's cached rail status is stale (already
    // idle here, but main hasn't heard about it yet over the rail:pushStatus
    // round-trip).
    const handleStopForClose = async () => {
        // Something may already be uploading -- a manual stop's own upload,
        // or a "retry upload" of older recordings. Wait for it rather than
        // start a competing one, or the close would destroy this window
        // (and the in-flight POST /process with it) mid-upload. A stop acks
        // for itself. A retry doesn't -- and a NEW recording can be live
        // while it runs, which then still has to be stopped and uploaded
        // below; this used to return here and let the window be destroyed
        // with that recording in it.
        const inFlight = inFlightUploadRef.current;
        if (inFlight) {
            await settled(inFlight.promise);
            if (inFlight.kind === "stop") return; // it acked for itself
        }
        // Read through the ref: after the wait above, this closure's
        // `status` is from before it.
        const liveStatus = statusRef.current;
        if (liveStatus !== "recording" && liveStatus !== "paused" && liveStatus !== "starting") {
            // Nothing recording and nothing uploading -- ack immediately
            // instead of hanging main's guarded close on an ack that was
            // never coming.
            ackStopAndSave();
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
            level: pushedLevels,
            recordError: displayError?.message ?? null,
            // Lets the docked pill offer the right action (retry upload vs.
            // open privacy settings) -- see DockedRail.
            recordErrorKind: displayError?.kind ?? null,
            isProcessing,
            hasPendingUpload: pendingUploadCount > 0,
        });
    }, [status, elapsed, pushedLevels, displayError, isProcessing, pendingUploadCount]);

    const commandHandlersRef = useRef({
        handleRecordClick,
        handlePauseClick,
        handlePlayClick,
        handleStopForClose,
        handleRetryUploadForClose,
        handleRetryUpload,
    });
    commandHandlersRef.current = {
        handleRecordClick,
        handlePauseClick,
        handlePlayClick,
        handleStopForClose,
        handleRetryUploadForClose,
        handleRetryUpload,
    };

    useEffect(() => {
        const unsubscribe = window.windowControls?.onRailCommand?.((action) => {
            if (action === "toggleRecord") commandHandlersRef.current.handleRecordClick();
            else if (action === "pause") commandHandlersRef.current.handlePauseClick();
            else if (action === "resume") commandHandlersRef.current.handlePlayClick();
            else if (action === "retryUpload") commandHandlersRef.current.handleRetryUpload();
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
                    <Record onClick={handleRecordClick} isRecording={isRecording} isStarting={isStarting} disabled={(isProcessing && !isRecording && !isPaused) || isStarting || isStartPending}/>
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
                        ? { label: "open privacy settings", onClick: () => window.settingsAPI?.openPrivacySettings?.(
                            window.electronAPI?.platform === "darwin" ? "screenRecording" : "microphone"
                          ) }
                        : undefined
                }
            />
        </div>
    )
}
