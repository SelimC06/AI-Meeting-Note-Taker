import React from "react";

const Pause: React.FC = () => {
    return (
        <button className="grid place-items-center h-10 w-10 rounded-lg border-2 border-black bg-gray-300/30 transition hover:brightness-110 activate:scale-95 focus:outline-none focus:ring-2 focus:ring-white/20">
            <div className="flex gap-1">
                <div className="h-5 w-2 bg-black rounded-[2px]" />
                <div className="h-5 w-2 bg-black rounded-[2px]" />
            </div>
        </button>
    )
}

export default Pause;