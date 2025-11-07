import React from "react";

const Play: React.FC = () => {
    return (
        <button
            className="grid place-items-center h-10 w-10 rounded-lg border-2 border-black bg-gray-300/30 transition hover:brightness-110 activate:scale-95 focus:outline-none focus:ring-2 focus:ring-white/20"
        >
            <svg viewBox="0 0 24 24" className="h-8 w-8 fill-black">
                <path d="M8 5v14l11-7z" />
            </svg>
        </button>
    )
}

export default Play;