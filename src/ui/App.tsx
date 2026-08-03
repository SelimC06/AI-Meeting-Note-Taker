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
      <div className="h-[450px] w-[800px] rounded-sm border border-line bg-void overflow-hidden flex flex-col">
        <TitleBar page={page} onChangePage={setPage}/>
        <main className="flex-1 min-h-0 overflow-hidden [-webkit-app-region:no-drag]">
          {page === "dashboard" && (
            <div key="dashboard" className="h-full animate-page-in">
              <DashboardCards onChangePage={setPage}/>
            </div>
          )}

          {page === "activity" && (
            <div key="activity" className="h-full animate-page-in">
              <YourActivityPage />
            </div>
          )}

          {page === "health" && (
            <div key="health" className="h-full animate-page-in">
              <HealthPage />
            </div>
          )}
        </main>
        </div>
      </div>
    </>
  )
}

export default App
