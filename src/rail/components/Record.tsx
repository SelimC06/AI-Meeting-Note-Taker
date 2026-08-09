import React from "react";

interface RecordProps {
    onClick?: () => void;
    isRecording?: boolean;
    isStarting?: boolean;
    disabled?: boolean;
}

const Record: React.FC<RecordProps> = ({ onClick, isRecording, isStarting, disabled }) => {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            aria-label={isStarting ? "Starting recording…" : isRecording ? "Stop recording" : "Start recording"}
            className={"grid h-6 w-6 flex-none place-items-center rounded-full transition " +
            "hover:brightness-110 active:scale-95 focus:outline-none " +
            "focus:ring-2 focus:ring-signal " +
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:scale-100 " +
            (isStarting ? "animate-pulse bg-red-500" : isRecording ? "bg-red-600" : "bg-red-500")}
        >
            <svg viewBox="0 0 24 24" className="h-3 w-3 fill-void">
                {isRecording ? <rect x="6" y="6" width="12" height="12" rx="2" /> : <circle cx="12" cy="12" r="9" />}
            </svg>
        </button>
    )
}

export default Record;
