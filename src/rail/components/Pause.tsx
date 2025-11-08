import React from "react";

interface PauseProps {
    onClick?: () => void;
    disabled?: boolean;
}

const Pause: React.FC<PauseProps> = ({ onClick, disabled }) => {
    return (
        <button onClick={disabled ? undefined : onClick} disabled={disabled} className={"grid place-items-center h-10 w-10 rounded-lg border-2 border-black bg-gray-300/30 transition hover:brightness-110 activate:scale-95 focus:outline-none focus:ring-2 focus:ring-white/20" + (disabled ? "opacity-40 cursor-not-allowed" : "")}>
            <div className="flex gap-1">
                <div className="h-5 w-2 bg-black rounded-[2px]" />
                <div className="h-5 w-2 bg-black rounded-[2px]" />
            </div>
        </button>
    )
}

export default Pause;