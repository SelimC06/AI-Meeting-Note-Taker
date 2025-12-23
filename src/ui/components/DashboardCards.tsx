// src/components/DashboardCards.tsx
import React from "react";
import type { MainPage } from "../App";

import YourActivity from "./YourActivity";
import Health from "./Health";
import Status from "./Status";
import Chat from "./Chat";

interface Props {
  onChangePage: (page: MainPage) => void;
}

const DashboardCards: React.FC<Props> = ({ onChangePage }) => {
  return (
    <>
        <div className="px-6 py-4 flex flex-row gap-4">
          <div
            onClick={() => onChangePage("activity")}
            className="cursor-pointer"
          >
            <YourActivity />
          </div>
          <div
            onClick={() => onChangePage("health")}
            className="cursor-pointer"
          >
            <Health />
          </div>
            <Status />
        </div>
        <div className="px-6 py-4 flex flex-row gap-4">
          <Chat />
        </div>
    </>
  );
};

export default DashboardCards;
