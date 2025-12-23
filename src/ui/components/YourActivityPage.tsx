import React from "react";

const YourActivityPage: React.FC = () => {
    return(
        <>
            <div className="h-full flex flex-col px-6 py-4 gap-3">
                <div className="flex items-baseline justify-between">
                    <div>
                        <h1 className="text-xl font-semibold text-white">Your Activity</h1>
                        <p className="text-xs text-neutral-400">
                            Recent meetings and notes captured by the app.
                        </p>
                    </div>
                </div>

                <div className="mt flex-1 rounded-2xl bg-neutral-900/80 border border-neutral-800 overflow-y-auto">
                    <div className="h-full flex items-center justify-center text-sm text-neutral-400">
                        No meetings recorded yet.
                    </div>
                </div>
            </div>
        </>
    )
}

export default YourActivityPage