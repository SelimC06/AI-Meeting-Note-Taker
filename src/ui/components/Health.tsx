import React from "react";

const Health: React.FC = () => {
  return (
    <div className="p-4 w-50 bg-panel border border-line rounded-sm text-phosphor">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[HEALTH]</h2>
      <div className="text-xs text-dim space-y-1">
        <p>cpu usage</p>
        <p>ram usage</p>
      </div>
    </div>
  );
};

export default Health;
