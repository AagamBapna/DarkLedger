import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PartyProvider } from "./context/PartyContext";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PartyProvider>
      <App />
    </PartyProvider>
  </React.StrictMode>
);
