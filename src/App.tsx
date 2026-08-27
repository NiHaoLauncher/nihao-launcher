import "./App.css";

import { Route, Routes, useParams } from "react-router-dom";
import MainLayout from "./layout/MainLayout";
import { HomePage } from "./launcher";
import ProfilePage from "./launcher/ProfilePage";
import { InitPage } from "./initialization";

import { useClient } from "./context/ClientContext";
import { GameModuleRenderer } from "./games/GameLoader.tsx";

export default function App() {

  return (
    <Routes>
      <Route path="/" element={<ProgramSelfAlive />} />
      <Route path="/init" element={<InitPage />} />
      <Route element={<MainLayout />}>
        <Route path="/home" element={<HomePage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/gm/:gameId/*" element={<GamePage/>} />
      </Route>
    </Routes>
  )
}
function ProgramSelfAlive() {
  const { localClient } = useClient();
  if (localClient==null) {
    document.location="/init";
  } else {
    document.location="/home";
  }
  return (<>Checking alls resources</>)
}

function GamePage() {
  const { gameId } = useParams<{ gameId: string }>();

  if (!gameId) {
    return <div>Error: Game ID is missing</div>;
  }

  return <GameModuleRenderer gameId={gameId} />;
}