import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import { Loading } from "./components/ui";
import { AuthProvider, isEmployee, useAuth } from "./lib/auth";
import BankApplication from "./pages/bank/BankApplication";
import BankNews from "./pages/bank/BankNews";
import BankQueue from "./pages/bank/BankQueue";
import ApplicationPage from "./pages/client/ApplicationPage";
import Applications from "./pages/client/Applications";
import Dashboard from "./pages/client/Dashboard";
import NewApplication from "./pages/client/NewApplication";
import Products from "./pages/client/Products";
import Login from "./pages/Login";
import "./styles.css";

function Guard({ employee, children }: { employee?: boolean; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (employee !== undefined && isEmployee(user) !== employee) return <Navigate to={isEmployee(user) ? "/bank" : "/"} replace />;
  return <Layout>{children}</Layout>;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Guard employee={false}><Dashboard /></Guard>} />
      <Route path="/products" element={<Guard employee={false}><Products /></Guard>} />
      <Route path="/applications" element={<Guard employee={false}><Applications /></Guard>} />
      <Route path="/applications/new" element={<Guard employee={false}><NewApplication /></Guard>} />
      <Route path="/applications/:id" element={<Guard employee={false}><ApplicationPage /></Guard>} />
      <Route path="/bank" element={<Guard employee><BankQueue /></Guard>} />
      <Route path="/bank/applications/:id" element={<Guard employee><BankApplication /></Guard>} />
      <Route path="/bank/news" element={<Guard employee><BankNews /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
