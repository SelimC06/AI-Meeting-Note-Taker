import React from "react";

interface PlayProps {
    onClick?: () => void;
    disabled?: boolean;
}

const Play: React.FC<PlayProps> = ({ onClick, disabled }) => {
    return (
        <button
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            className={"grid place-items-center h-10 w-10 rounded-sm border-2 border-signal/60 bg-panel transition hover:brightness-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-signal "+(disabled ? "opacity-40 cursor-not-allowed" : "")}
        >
            <svg viewBox="0 0 24 24" className="h-8 w-8 fill-signal">
                <path d="M8 5v14l11-7z" />
            </svg>
        </button>
    )
}

export default Play;
