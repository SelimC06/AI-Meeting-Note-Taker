import React from "react";

interface PauseResumeProps {
    status: "recording" | "paused";
    onClick?: () => void;
    disabled?: boolean;
}

const PauseResume: React.FC<PauseResumeProps> = ({ status, onClick, disabled }) => {
    const isPaused = status === "paused";
    return (
        <button
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            aria-label={isPaused ? "Resume recording" : "Pause recording"}
            className={"grid h-6 w-6 flex-none place-items-center rounded-sm border border-line bg-panel transition " +
            "hover:brightness-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-signal " +
            (disabled ? "opacity-40 cursor-not-allowed" : "")}
        >
            {isPaused ? (
                <svg viewBox="0 0 24 24" className="h-3 w-3 fill-signal">
                    <path d="M8 5v14l11-7z" />
                </svg>
            ) : (
                <div className="flex gap-[3px]">
                    <div className="h-3 w-[3px] rounded-[1px] bg-signal" />
                    <div className="h-3 w-[3px] rounded-[1px] bg-signal" />
                </div>
            )}
        </button>
    )
}

export default PauseResume;
