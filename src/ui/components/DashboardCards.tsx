// src/components/DashboardCards.tsx
import React from "react";
import type { MainPage } from "../App";

import YourActivity from "./YourActivity";
import Health from "./Health";
import Status from "./Status";
import Chat from "./Chat";
import Models from "./Models";

interface Props {
  onChangePage: (page: MainPage) => void;
  active: boolean;
}

const DashboardCards: React.FC<Props> = ({ onChangePage, active }) => {
  return (
    <>
        <div className="px-6 py-4 flex flex-row gap-4">
          <div
            onClick={() => onChangePage("activity")}
            className="cursor-pointer"
          >
            <YourActivity active={active}/>
          </div>
          <div
            onClick={() => onChangePage("health")}
            className="cursor-pointer"
          >
            <Health active={active} />
          </div>
            <Status active={active} />
        </div>
        <div className="px-6 py-4 flex flex-row gap-4">
          <div
            onClick={() => onChangePage("settings")}
            className="cursor-pointer"
          >
            <Models active={active}/>
          </div>
          <Chat active={active}/>
        </div>
    </>
  );
};

export default DashboardCards;
