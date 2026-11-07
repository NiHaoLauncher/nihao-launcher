// First: applies the active theme (tokens + motion) before anything renders.
import { ThemeSlotsProvider } from "./state/Theme";
import ReactDOM from "react-dom/client";
import App from "./App";
import { BrowserRouter } from "react-router-dom";
import { ModalProvider } from "./context/ModalContext";
import { AuthProvider } from "./context/AuthContext";
import { ToastProvider } from "./context/ToastContext";
import SocialWindow from "./social/SocialWindow";
import { hideBoot } from "./boot";

const root = ReactDOM.createRoot(document.getElementById("app") as HTMLElement);

// The friends list is its own OS window running this bundle (see social_window.rs): it gets the
// small root below, not the whole launcher.
if (new URLSearchParams(location.search).get("window") === "social") {
  hideBoot();
  root.render(
    <ThemeSlotsProvider>
      <SocialWindow />
    </ThemeSlotsProvider>,
  );
} else {
  root.render(
    <BrowserRouter>
      <ThemeSlotsProvider>
        <AuthProvider>
          <ModalProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </ModalProvider>
        </AuthProvider>
      </ThemeSlotsProvider>
    </BrowserRouter>,
  );
}
