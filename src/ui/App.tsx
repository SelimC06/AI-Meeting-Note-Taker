import TitleBar from './components/TitleBar';
import DashboardCards from './components/DashboardCards';
import HealthPage from './components/HealthPage';
import YourActivityPage from './components/YourActivityPage';
import { useState } from 'react';

export type MainPage = "dashboard" | "activity" | "health";

function App() {
  const [page, setPage] = useState<MainPage>("dashboard");
  return (
    <>
      <div className="h-full flex items-center justify-center">
      <div className="h-[450px] w-[800px] rounded-2xl border-2 border-gray bg-neutral-900/90 overflow-hidden shadow-xl flex flex-col">
        <TitleBar onChangePage={setPage}/>
        <main className="flex-1 min-h-0 [-webkit-app-region:no-drag]">
          {page === "dashboard" && (
            <DashboardCards onChangePage={setPage}/>
          )}

          {page === "activity" && (
            <YourActivityPage />
          )}

          {page === "health" && (
            <HealthPage />
          )}
        </main>
        </div>
      </div>
    </>
  )
}

export default App
