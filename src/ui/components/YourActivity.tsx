import React from "react";

const YourActivity: React.FC = () => {
    return (
    <div className="p-4 w-50 bg-zinc-800/55 rounded-xl backdrop-blur-md backdrop-saturate-150 border border-white/12 shadow-[0_8px_32px_rgba(0,0,0,0.25)] text-white">
      <h2 className="text-lg font-semibold mb-2">Your Activity</h2>
      <div className="text-xs">
        <p>• Recent notes</p>
        <p>• Meetings recorded</p>
      </div>
    </div>
  );
};

export default YourActivity
