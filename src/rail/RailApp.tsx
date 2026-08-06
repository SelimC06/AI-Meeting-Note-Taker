//import React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import './rail.css';
import Record from "./components/Record";
import Pause from "./components/Pause";
import Play from "./components/Play"
import ErrorToast from "./components/ErrorToast";
import { useThreeTrackSegments } from './hooks/useThreeTrackSegments';

const BACKEND_URL =
  import.meta.env.VITE_MEETING_API_URL ?? "http://localhost:8000";

export default function RailApp() {
    const { status, record, pause, resume, stop, error: recordError } = useThreeTrackSegments();

    const [resultFlash, setResultFlash] = useState<"success" | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processError, setProcessError] = useState<string | null>(null);
    const [toastDismissed, setToastDismissed] = useState(false);

    useEffect(() => {
        if (resultFlash === null) return;
        const timer = setTimeout(() => setResultFlash(null), 2000);
        return () => clearTimeout(timer);
    }, [resultFlash]);

    const isRecording = status === "recording";
    const isPaused = status === "paused";
    const displayError = recordError ?? processError;

    const previousErrorRef = useRef<string | null>(null);
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
                let resp: Response;
                try {
                    resp = await fetch(`${BACKEND_URL}/process`, {
                        method: "POST",
                        body: formData,
                    });
                } catch (networkErr) {
                    if (networkErr instanceof TypeError) {
                        throw new Error("Couldn't reach the app backend — is it running?");
                    }
                    throw networkErr;
                }

                if (!resp.ok) {
                    const text = await resp.text();
                    let detail: string;
                    try {
                        const body = JSON.parse(text);
                        detail = typeof body?.detail === "string" ? body.detail : JSON.stringify(body);
                    } catch {
                        detail = text;
                    }
                    throw new Error(detail);
                }

                setResultFlash("success");
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
        <div className="h-full w-full flex items-center gap-2">
            <div className="h-full w-[72px] flex-none overflow-hidden rounded-[999px] bg-void border border-signal/40 flex flex-col items-center gap-3 py-4 select-none">
                <Record onClick={handleRecordClick} isRecording={isRecording} disabled={isProcessing}/>

                <div className="h-px w-[42px] bg-line" />

                <Pause onClick={handlePauseClick} disabled={!isRecording}/>
                <Play onClick={handlePlayClick} disabled={!isPaused}/>

                <span
                    title={isProcessing ? "Processing recording…" : displayError ?? undefined}
                    className={
                        "mt-auto h-2.5 w-2.5 rounded-full border border-void transition-colors " +
                        (isProcessing
                            ? "bg-amber-400 animate-pulse"
                            : displayError
                            ? "bg-red-500"
                            : resultFlash === "success"
                            ? "bg-signal"
                            : "bg-dim")
                    }
                />
            </div>
            <ErrorToast message={toastDismissed ? null : displayError ?? null} onDismiss={handleDismissError} />
        </div>
    )
}