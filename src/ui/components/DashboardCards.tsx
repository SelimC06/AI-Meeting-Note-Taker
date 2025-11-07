// src/components/DashboardCards.tsx
import React from "react";
import YourActivity from "./YourActivity";
import Health from "./Health";
import Status from "./Status";
import Chat from "./Chat";

const DashboardCards: React.FC = () => {
  return (
    <>
        <div className="px-6 py-4 flex flex-row gap-4">
            <YourActivity />
            <Health />
            <Status />
        </div>
        <div className="px-6 py-4 flex flex-row gap-4">
            <Chat />
        </div>
    </>
  );
};

export default DashboardCards;
