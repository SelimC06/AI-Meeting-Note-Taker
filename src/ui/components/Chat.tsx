import React from "react";

const Chat: React.FC = () => {
    return (
        <div className="p-4 w-[50%] h-[240px] bg-zinc-800/55 rounded-xl backdrop-blur-md backdrop-saturate-150 border border-white/12 shadow-[0_8px_32px_rgba(0,0,0,0.25)] text-white flex flex-col [-webkit-app-region:no-drag]">
            <form className="mt-auto no-drag relative z-50 pointer-events-auto">
                <input
                    type="text"
                    placeholder="Type your message..."
                    className="block w-full p-2 text-gray-900 border border-gray-300 rounded-lg bg-gray-50 text-xs dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500"
                />
            </form>
        </div>
    )
}

export default Chat