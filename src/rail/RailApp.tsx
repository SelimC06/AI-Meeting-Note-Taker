//import React from "react";
import './rail.css';
import Record from "./components/Record";
import Pause from "./components/Pause";
import Play from "./components/Play"

export default function RailApp() {
    return (
        <div className="h-full w-full overflow-hidden rounded-[999px] bg-neutral-900/90 border-2 border-black-300 flex flex-col items-center gap-3 py-4 select-none">
            <Record />

            <div className="h-px w-[42px] bg-[rgba(145,145,145,0.3)]" />

            <Pause />
            <Play />

            <span className="mt-auto h-2.5 w-2.5 rounded-full bg-gray-400 border border-black" />
        </div>
    )
}