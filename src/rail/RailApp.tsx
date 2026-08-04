//import React from "react";
import { useEffect, useState } from "react";
import './rail.css';
import Record from "./components/Record";
import Pause from "./components/Pause";
import Play from "./components/Play"
import { useThreeTrackSegments } from './hooks/useThreeTrackSegments';

const BACKEND_URL =
  import.meta.env.VITE_MEETING_API_URL ?? "http://localhost:8000";

export default function RailApp() {
    const { status, record, pause, resume, stop } = useThreeTrackSegments();

    const [resultFlash, setResultFlash] = useState<"success" | "error" | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);

    useEffect(() => {
        if (resultFlash === null) return;
        const timer = setTimeout(() => setResultFlash(null), 2000);
        return () => clearTimeout(timer);
    }, [resultFlash]);

    const isRecording = status === "recording";
    const isPaused = status === "paused";

    const handleRecordClick = async () => {
        if (isProcessing) return;

        try {
            if (status === "idle") {
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
                const resp = await fetch(`${BACKEND_URL}/process`, {
                    method: "POST",
                    body: formData,
                });

                if (!resp.ok) {
                    const text = await resp.text();
                    throw new Error(`Backend error ${resp.status}: ${text}`);
                }

                setResultFlash("success");
            } catch (err) {
                console.error("/process failed", err);
                setResultFlash("error");
            } finally {
                setIsProcessing(false);
            }
        }
        } catch (err) {
            console.error("record/stop error", err);
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

    return (
        <div className="h-full w-full overflow-hidden rounded-[999px] bg-void border border-signal/40 flex flex-col items-center gap-3 py-4 select-none">
            <Record onClick={handleRecordClick} isRecording={isRecording} disabled={isProcessing}/>

            <div className="h-px w-[42px] bg-line" />

            <Pause onClick={handlePauseClick} disabled={!isRecording}/>
            <Play onClick={handlePlayClick} disabled={!isPaused}/>

            <span
                title={isProcessing ? "Processing recording…" : undefined}
                className={
                    "mt-auto h-2.5 w-2.5 rounded-full border border-void transition-colors " +
                    (isProcessing
                        ? "bg-amber-400 animate-pulse"
                        : resultFlash === "success"
                        ? "bg-signal"
                        : resultFlash === "error"
                        ? "bg-red-500"
                        : "bg-dim")
                }
            />
        </div>
    )
}