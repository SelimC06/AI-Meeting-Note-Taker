import React from "react";

const HealthPage: React.FC = () => {
    const cpuUsage = 37;  // %
    const ramUsage = 62;
    const overall = Math.round((cpuUsage + ramUsage) / 2);
    
    return(
        <>
            <div className="h-full flex flex-col px-6 py-4 gap-3">
                <div>
                    <h1 className="text-xl font-semibold text-white">Health</h1>
                    <p className="text-xs text-neutral-400">
                        System usage while recording meetings.
                    </p>
                </div>

                <div className="mt flex-1 flex flex-row items-center gap-6">
                    <div className="flex-[0.6] h-full rounded-2xl bg-neutral-900/80 border border-neutral-800 p-4 flex flex-col gap-4">
                        <div>
                            <h2 className="text-sm font-semibold text-white">CPU Usage</h2>
                            <p className="text-2xl font-semibold text-emerald-400">
                                {cpuUsage}%
                            </p>
                            <p className="text-xs text-neutral-400">
                                Lower is better while recording. Consider closing heavy apps if
                                this regularly exceeds ~80%.
                            </p>
                        </div>

                        <div>
                            <h2 className="text-sm font-semibold text-white">Memory Usage</h2>
                            <p className="text-2xl font-semibold text-sky-400">
                                {ramUsage}%
                            </p>
                            <p className="text-xs text-neutral-400">
                                High memory usage can affect transcription speed.
                            </p>
                        </div>
                    </div>

                    <div className="flex-[0.4] flex items-center justify-center">
                        <div className="relative w-70 h-70 rounded-full bg-neutral-900 flex items-center justify-center">
                            <div className="absolute inset-1 rounded-full border border-neutral-600" />
                                <div className="absolute inset-3 rounded-full border border-neutral-800" />
                                    <div className="text-center text-neutral-200 text-ms">
                                        Overall load
                                    <div className="text-5xl font-semibold text-white mt-1">
                                        {overall}%
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </>
    )
}

export default HealthPage