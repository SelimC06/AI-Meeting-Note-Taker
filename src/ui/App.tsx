import TitleBar from './components/TitleBar'
import DashboardCards from './components/DashboardCards'

function App() {
  return (
    <>
      <div className="h-full flex items-center justify-center">
      <div className="h-[450px] w-[800px] rounded-2xl border-2 border-gray bg-neutral-900/90 overflow-hidden shadow-xl flex flex-col">
        <TitleBar />
        <main className="flex-1 min-h-0 [-webkit-app-region:no-drag]">
          <DashboardCards />
        </main>
        </div>
      </div>
    </>
  )
}

export default App
