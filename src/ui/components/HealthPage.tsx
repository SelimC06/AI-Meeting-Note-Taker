import React from "react";

const HealthPage: React.FC = () => {
    return(
        <>
            <div className="h-full flex flex-col px-6 py-4 gap-3 text-phosphor">
                <div>
                    <h1 className="text-sm font-semibold tracking-wide uppercase">[HEALTH]</h1>
                    <p className="text-xs text-dim">
                        system usage while recording meetings
                    </p>
                </div>

                <div className="mt flex-1 flex flex-row items-center gap-6">
                    <div className="flex-[0.6] h-full rounded-sm bg-panel border border-line p-4 flex flex-col gap-4">
                        <div>
                            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">cpu usage</h2>
                            <p className="text-2xl font-semibold text-signal">
                                --
                            </p>
                            <p className="text-xs text-dim">
                                live monitoring isn't wired up yet.
                            </p>
                        </div>

                        <div>
                            <h2 className="text-xs font-semibold text-dim uppercase tracking-wide">memory usage</h2>
                            <p className="text-2xl font-semibold text-signal">
                                --
                            </p>
                            <p className="text-xs text-dim">
                                live monitoring isn't wired up yet.
                            </p>
                        </div>
                    </div>

                    <div className="flex-[0.4] flex items-center justify-center">
                        <div className="relative w-70 h-70 rounded-full bg-panel border border-line flex items-center justify-center">
                            <div className="absolute inset-1 rounded-full border border-line" />
                                <div className="absolute inset-3 rounded-full border border-line" />
                                    <div className="text-center text-dim text-ms">
                                        overall load
                                    <div className="text-5xl font-semibold text-signal mt-1">
                                        --
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
