import TitleBar from './components/TitleBar';
import DashboardCards from './components/DashboardCards';
import HealthPage from './components/HealthPage';
import YourActivityPage from './components/YourActivityPage';
import SettingsPage from './components/SettingsPage';
import ErrorBoundary from './components/ErrorBoundary';
import BackendStatusBanner from './components/BackendStatusBanner';
import OllamaOnboardingGate from './components/OllamaOnboardingGate';
import { useState } from 'react';

export type MainPage = "dashboard" | "activity" | "health" | "settings";

function App() {
  const [page, setPage] = useState<MainPage>("dashboard");
  return (
    <>
      <div className="h-full flex items-center justify-center">
      <div className="h-[450px] w-[800px] rounded-sm border border-line bg-void overflow-hidden flex flex-col">
        <TitleBar page={page} onChangePage={setPage}/>
        <main className="flex-1 min-h-0 overflow-hidden [-webkit-app-region:no-drag] relative">
          <BackendStatusBanner />
          <div
            className={
              "absolute inset-0 h-full transition-opacity duration-150 " +
              (page === "dashboard" ? "opacity-100" : "opacity-0 pointer-events-none")
            }
          >
            <ErrorBoundary resetKey={page}>
              <DashboardCards onChangePage={setPage} active={page === "dashboard"}/>
              <OllamaOnboardingGate active={page === "dashboard"} />
            </ErrorBoundary>
          </div>

          <div
            className={
              "absolute inset-0 h-full transition-opacity duration-150 " +
              (page === "activity" ? "opacity-100" : "opacity-0 pointer-events-none")
            }
          >
            <ErrorBoundary resetKey={page}>
              <YourActivityPage active={page === "activity"}/>
            </ErrorBoundary>
          </div>

          <div
            className={
              "absolute inset-0 h-full transition-opacity duration-150 " +
              (page === "health" ? "opacity-100" : "opacity-0 pointer-events-none")
            }
          >
            <ErrorBoundary resetKey={page}>
              <HealthPage />
            </ErrorBoundary>
          </div>

          <div
            className={
              "absolute inset-0 h-full transition-opacity duration-150 " +
              (page === "settings" ? "opacity-100" : "opacity-0 pointer-events-none")
            }
          >
            <ErrorBoundary resetKey={page}>
              <SettingsPage active={page === "settings"} />
            </ErrorBoundary>
          </div>
        </main>
        </div>
      </div>
    </>
  )
}

export default App
