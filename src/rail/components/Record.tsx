import React from "react";

interface RecordProps {
    onClick?: () => void;
    isRecording?: boolean;
    disabled?: boolean;
}

const Record: React.FC<RecordProps> = ({ onClick, isRecording, disabled }) => {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={"h-10 w-10 rounded-full border-2 border-line shadow-sm transition " +
            "hover:brightness-110 active:scale-95 focus:outline-none " +
            "focus:ring-2 focus:ring-signal " +
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:scale-100 " +
            (isRecording ? "bg-red-600" : "bg-red-500")}
        />
    )
}

export default Record;
