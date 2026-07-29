import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/noto-sans-sc";
import { EditorApp } from "./app/App";
import { Toaster } from "./components/ui/sonner";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EditorApp />
    <Toaster />
  </StrictMode>,
);
