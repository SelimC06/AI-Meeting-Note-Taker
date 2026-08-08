import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import './rail.css';
import Record from "./components/Record";
import PauseResume from "./components/PauseResume";
import LevelMeter from "./components/LevelMeter";
import ErrorToast from "./components/ErrorToast";
import { useThreeTrackSegments, type ClassifiedError } from './hooks/useThreeTrackSegments';
import { useElapsedTime } from './hooks/useElapsedTime';
import { useMicLevel } from './hooks/useMicLevel';
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

    const handleRecordClick = async () => {
        if (isProcessing) return;

        try {
            if (status === "idle") {
                setProcessError(null);
                await record();
        } else if (status === "recording" || status === "paused") {
                const blobs = await stop();

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

                addJob(result.job_id);
            } catch (err) {
                console.error("/process failed", err);
                setProcessError(err instanceof Error ? err.message : String(err));
            } finally {
                setIsProcessing(false);
            }
        }
        } catch (err) {
            console.error("record/stop error", err);
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

    return (
        <div className="flex h-full w-full flex-col items-center gap-2">
            <div className="flex h-10 w-full flex-none items-center gap-3 rounded-full border border-signal/40 bg-void px-3 select-none">
                <Record onClick={handleRecordClick} isRecording={isRecording} disabled={isProcessing}/>

                <span
                    aria-label="Elapsed recording time"
                    role="timer"
                    className="font-mono text-[11px] tabular-nums text-phosphor"
                >{elapsed}</span>

                <LevelMeter levels={levels} active={isRecording} />

                <div className="h-4 w-px flex-none bg-line" />

                <PauseResume
                    status={isPaused ? "paused" : "recording"}
                    onClick={isPaused ? handlePlayClick : handlePauseClick}
                    disabled={!isRecording && !isPaused}
                />

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
                    !toastDismissed && displayError?.kind === "permission-denied"
                        ? { label: "open privacy settings", onClick: () => window.settingsAPI?.openPrivacySettings?.("microphone") }
                        : undefined
                }
            />
        </div>
    )
}
