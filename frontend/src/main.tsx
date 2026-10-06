import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider } from "./auth";
import { Layout } from "./Layout";
import {
  ActivitiesPage,
  ActivityDetailRoute,
  CreateActivityPage,
  LoginPage,
  MyRegistrationsPage,
  NotFoundPage,
  ProtectedRoute,
} from "./pages";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#6554d7",
          colorText: "#202747",
          colorTextSecondary: "#758096",
          colorBorder: "#dfe2ec",
          colorBgLayout: "#f7f8fb",
          fontFamily:
            "'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
          borderRadius: 10,
          controlHeight: 40,
          controlHeightLG: 48,
          fontSize: 14,
        },
      }}
    >
      <AntApp>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Navigate to="/activities" replace />} />
                <Route path="activities" element={<ActivitiesPage />} />
                <Route
                  path="activities/:id"
                  element={<ActivityDetailRoute />}
                />
                <Route path="login" element={<LoginPage />} />
                <Route
                  path="my-registrations"
                  element={
                    <ProtectedRoute>
                      <MyRegistrationsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/activities/new"
                  element={
                    <ProtectedRoute admin>
                      <CreateActivityPage />
                    </ProtectedRoute>
                  }
                />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
