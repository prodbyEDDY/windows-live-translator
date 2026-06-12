import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./index.css";

// Dev-only: expose the store for design QA (state injection in a browser).
if (import.meta.env.DEV) {
  void import("./stores/app").then((m) => {
    (window as unknown as { __store?: unknown }).__store = m.useAppStore;
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
