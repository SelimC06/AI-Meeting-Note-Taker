//import React from "react";
import { useEffect, useState } from "react";
import './rail.css';
import Record from "./components/Record";
import Pause from "./components/Pause";
import Play from "./components/Play"
import { useThreeTrackSegments } from './hooks/useThreeTrackSegments';

type ProcessResponse = {
  notes: string;
  video_path: string;
  session: string;
};

const BACKEND_URL =
  import.meta.env.VITE_MEETING_API_URL ?? "http://localhost:8000";

export default function RailApp() {
    const { status, record, pause, resume, stop } = useThreeTrackSegments();

    const [resultFlash, setResultFlash] = useState<"success" | "error" | null>(null);

    useEffect(() => {
        if (resultFlash === null) return;
        const timer = setTimeout(() => setResultFlash(null), 2000);
        return () => clearTimeout(timer);
    }, [resultFlash]);

    const isRecording = status === "recording";
    const isPaused = status === "paused";

    const handleRecordClick = async () => {
        try {
            if (status === "idle") {
                await record();
        } else if (status === "recording" || status === "paused") {
                const blobs = await stop();
                console.log("stop() finished. Blobs:", {
                screen: blobs.screen?.size,
                systemAudio: blobs.systemAudio?.size,
                micAudio: blobs.micAudio?.size,
            });

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

            try {
                const resp = await fetch(`${BACKEND_URL}/process`, {
                    method: "POST",
                    body: formData,
                });

                if (!resp.ok) {
                    const text = await resp.text();
                    throw new Error(`Backend error ${resp.status}: ${text}`);
                }

                const data = (await resp.json()) as ProcessResponse;
                console.log("[Rail] backend /process result:", data);
                setResultFlash("success");
            } catch (err) {
                console.error("/process failed", err);
                setResultFlash("error");
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
            <Record onClick={handleRecordClick} isRecording={isRecording}/>

            <div className="h-px w-[42px] bg-[rgba(145,145,145,0.3)]" />

            <Pause onClick={handlePauseClick} disabled={!isRecording}/>
            <Play onClick={handlePlayClick} disabled={!isPaused}/>

            <span
                className={
                    "mt-auto h-2.5 w-2.5 rounded-full border border-void transition-colors " +
                    (resultFlash === "success"
                        ? "bg-signal"
                        : resultFlash === "error"
                        ? "bg-red-500"
                        : "bg-dim")
                }
            />
        </div>
    )
}