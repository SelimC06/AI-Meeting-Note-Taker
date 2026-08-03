import React from "react";

const Chat: React.FC = () => {
  return (
    <div className="p-4 w-[50%] h-[240px] bg-panel border border-line rounded-sm text-phosphor flex flex-col [-webkit-app-region:no-drag]">
      <h2 className="text-xs font-semibold mb-2 tracking-wide uppercase text-dim">[CHAT]</h2>
      <div className="mt-auto no-drag relative z-50 pointer-events-auto">
        <input
          type="text"
          value=""
          disabled
          readOnly
          placeholder="> ask about this meeting (coming soon)"
          className="block w-full p-2 text-dim border border-line rounded-sm bg-panel text-xs placeholder:text-dim cursor-not-allowed"
        />
      </div>
    </div>
  );
};

export default Chat;
