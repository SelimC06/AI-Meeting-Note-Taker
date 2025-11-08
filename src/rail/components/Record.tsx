import React from "react";

interface RecordProps {
    onClick?: () => void;
    isRecording?: boolean;
}

const Record: React.FC<RecordProps> = ({ onClick, isRecording }) => {
    return (
        <button 
            onClick={onClick} 
            className={"h-10 w-10 rounded-full border-2 border-white shadow-sm transition " +
            "hover:brightness-110 active:scale-95 focus:outline-none " +
            "focus:ring-2 focus:ring-white/40 " +
            (isRecording ? "bg-red-600" : "bg-red-500")}
        />
    )
}

export default Record;