import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider } from "./auth";
import { NotificationProvider } from "./notifications";
import { Layout } from "./Layout";
import { ActivitiesPage } from "./pages/ActivitiesPage";
import { ActivityDetailRoute } from "./pages/ActivityDetailPage";
import { CreateActivityPage } from "./pages/CreateActivityPage";
import { EditActivityRoute } from "./pages/EditActivityPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { ProfilePage } from "./pages/ProfilePage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { MyRegistrationsPage } from "./pages/MyRegistrationsPage";
import { NotFoundPage, ProtectedRoute } from "./pages/AccessPages";
import { AdminDashboardPage } from "./pages/AdminDashboardPage";
import { AdminActivitiesPage } from "./pages/AdminActivitiesPage";
import { AdminRegistrationsRoute } from "./pages/AdminRegistrationsPage";
import { AdminMonitoringPage } from "./pages/AdminMonitoringPage";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#1677ff",
          colorText: "#1f1f1f",
          colorTextSecondary: "#595959",
          colorBorder: "#d9d9d9",
          colorBgLayout: "#f0f2f5",
          fontFamily:
            "'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
          borderRadius: 6,
          controlHeight: 36,
          controlHeightLG: 44,
          fontSize: 14,
        },
      }}
    >
      <AntApp>
        <BrowserRouter>
          <AuthProvider>
            <NotificationProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Navigate to="/activities" replace />} />
                <Route path="activities" element={<ActivitiesPage />} />
                <Route
                  path="activities/:id"
                  element={<ActivityDetailRoute />}
                />
                <Route path="login" element={<LoginPage />} />
                <Route path="register" element={<RegisterPage />} />
                <Route path="notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />
                <Route
                  path="profile"
                  element={
                    <ProtectedRoute>
                      <ProfilePage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="my-registrations"
                  element={
                    <ProtectedRoute>
                      <MyRegistrationsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/dashboard"
                  element={
                    <ProtectedRoute admin>
                      <AdminDashboardPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/monitoring"
                  element={
                    <ProtectedRoute admin>
                      <AdminMonitoringPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/activities"
                  element={
                    <ProtectedRoute admin>
                      <AdminActivitiesPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/activities/:id/registrations"
                  element={
                    <ProtectedRoute admin>
                      <AdminRegistrationsRoute />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/activities/:id/edit"
                  element={
                    <ProtectedRoute admin>
                      <EditActivityRoute />
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
            </NotificationProvider>
          </AuthProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
