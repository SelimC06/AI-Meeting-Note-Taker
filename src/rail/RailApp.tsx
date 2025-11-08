//import React from "react";
import './rail.css';
import Record from "./components/Record";
import Pause from "./components/Pause";
import Play from "./components/Play"
import { useThreeTrackSegments } from './hooks/useThreeTrackSegments';

export default function RailApp() {
    const { status, record, pause, resume, stop } = useThreeTrackSegments();

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
        <div className="h-full w-full overflow-hidden rounded-[999px] bg-neutral-900/90 border-2 border-black-300 flex flex-col items-center gap-3 py-4 select-none">
            <Record onClick={handleRecordClick} isRecording={isRecording}/>

            <div className="h-px w-[42px] bg-[rgba(145,145,145,0.3)]" />

            <Pause onClick={handlePauseClick} disabled={!isRecording}/>
            <Play onClick={handlePlayClick} disabled={!isPaused}/>

            <span className="mt-auto h-2.5 w-2.5 rounded-full bg-gray-400 border border-black" />
        </div>
    )
}