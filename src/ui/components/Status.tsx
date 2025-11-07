import React, { useState } from "react";

const Status: React.FC = () => {
    const [isChecked, setIsChecked] = useState(false)

    const handleCheckboxChange = () =>{
        setIsChecked(!isChecked)
    }


    return (
    <div className="p-4 w-100 bg-zinc-800/55 rounded-xl backdrop-blur-md backdrop-saturate-150 border border-white/12 shadow-[0_8px_32px_rgba(0,0,0,0.25)] text-white">
      <h2 className="text-lg font-semibold mb-2">Status (Offline/Online)</h2>
      <div className="mt-2 flex justify-end">
        <label className='flex cursor-pointer select-none items-center'>
        <div className='relative'>
          <input
            type='checkbox'
            checked={isChecked}
            onChange={handleCheckboxChange}
            className='sr-only'
          />
            {/* background color changes based on isChecked */}
            <div
            className={`block h-8 w-14 rounded-full transition ${
                isChecked ? "bg-green-500" : "bg-gray-300"
            }`}
            />
            {/* dot slides using translate-x */}
            <div
            className={`dot absolute top-1 h-6 w-6 rounded-full bg-white transition-transform ${
                isChecked ? "translate-x-7" : "translate-x-1"
            }`}
            />
        </div>
      </label>
      </div>
      </div>
  );
};

export default Status
