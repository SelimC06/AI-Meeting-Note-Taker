import React from "react";

interface LevelMeterProps {
  levels: number[];
  active: boolean;
}

const LevelMeter: React.FC<LevelMeterProps> = ({ levels, active }) => (
  <div className="flex h-4 flex-none items-end gap-[2px]" aria-hidden="true">
    {levels.map((level, i) => (
      <span
        key={i}
        className={
          "w-[2px] rounded-[1px] transition-[height] duration-75 " +
          (active ? "bg-signal" : "bg-line")
        }
        style={{ height: `${Math.max(15, level * 100)}%` }}
      />
    ))}
  </div>
);

export default LevelMeter;
