import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider } from "./auth";
import { NotificationProvider } from "./notifications";
import { Layout } from "./Layout";
import { ActivitiesPage } from "./pages/ActivitiesPage";
import { NotFoundPage, ProtectedRoute } from "./pages/AccessPages";
import "./styles.css";

// Keep lazy identities outside renders. ProtectedRoute decides whether an
// authorized page is rendered before React invokes its dynamic import.
const ActivityDetailRoute = lazy(() => import("./pages/ActivityDetailPage")
  .then(module => ({ default: module.ActivityDetailRoute })));
const CreateActivityPage = lazy(() => import("./pages/CreateActivityPage")
  .then(module => ({ default: module.CreateActivityPage })));
const EditActivityRoute = lazy(() => import("./pages/EditActivityPage")
  .then(module => ({ default: module.EditActivityRoute })));
const LoginPage = lazy(() => import("./pages/LoginPage")
  .then(module => ({ default: module.LoginPage })));
const RegisterPage = lazy(() => import("./pages/RegisterPage")
  .then(module => ({ default: module.RegisterPage })));
const ProfilePage = lazy(() => import("./pages/ProfilePage")
  .then(module => ({ default: module.ProfilePage })));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage")
  .then(module => ({ default: module.NotificationsPage })));
const MyRegistrationsPage = lazy(() => import("./pages/MyRegistrationsPage")
  .then(module => ({ default: module.MyRegistrationsPage })));
const AdminDashboardPage = lazy(() => import("./pages/AdminDashboardPage")
  .then(module => ({ default: module.AdminDashboardPage })));
const AdminActivitiesPage = lazy(() => import("./pages/AdminActivitiesPage")
  .then(module => ({ default: module.AdminActivitiesPage })));
const AdminRegistrationsRoute = lazy(() => import("./pages/AdminRegistrationsPage")
  .then(module => ({ default: module.AdminRegistrationsRoute })));
const AdminMonitoringPage = lazy(() => import("./pages/AdminMonitoringPage")
  .then(module => ({ default: module.AdminMonitoringPage })));
const AdminAuditLogsPage = lazy(() => import("./pages/AdminAuditLogsPage")
  .then(module => ({ default: module.AdminAuditLogsPage })));

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
                <Route path="admin/audit-logs" element={
                  <ProtectedRoute admin><AdminAuditLogsPage /></ProtectedRoute>
                } />
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
