import { useEffect, useRef, useState } from "react";
import {
  App as AntApp,
  Avatar,
  Button,
  Drawer,
  Dropdown,
  Spin,
  Tooltip,
} from "antd";
import {
  CalendarOutlined,
  AreaChartOutlined,
  DashboardOutlined,
  DownOutlined,
  FileAddOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ProfileOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "./auth";
import { errorMessage } from "./api";
import { Logo } from "./components";

export function Layout() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntApp.useApp();
  const [loggingOut, setLoggingOut] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const links = [
    {
      to: "/activities",
      label: "发现活动",
      icon: <CalendarOutlined aria-hidden="true" />,
    },
    ...(auth.user?.role === "ADMIN"
      ? [
          {
            to: "/admin/dashboard",
            label: "概览",
            icon: <DashboardOutlined aria-hidden="true" />,
          },
          {
            to: "/admin/activities",
            label: "活动管理",
            icon: <ProfileOutlined aria-hidden="true" />,
          },
          {
            to: "/admin/activities/new",
            label: "发布活动",
            icon: <FileAddOutlined aria-hidden="true" />,
          },
          {
            to: "/admin/monitoring",
            label: "运行指标",
            icon: <AreaChartOutlined aria-hidden="true" />,
          },
        ]
      : []),
    ...(auth.user
      ? [
          {
            to: "/my-registrations",
            label: "我的报名",
            icon: <TeamOutlined aria-hidden="true" />,
          },
        ]
      : []),
  ];

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    mainRef.current?.focus({ preventScroll: true });
    setMobileOpen(false);
  }, [location.pathname]);

  async function logout() {
    setLoggingOut(true);
    try {
      await auth.logout();
      message.success("已退出登录");
      navigate("/activities");
    } catch (error) {
      message.error(errorMessage(error));
    } finally {
      setLoggingOut(false);
    }
  }

  function navigation(inDrawer = false) {
    return (
      <nav className="side-navigation" aria-label="主导航">
        {links.map((link) => {
          const active =
            link.to === "/admin/activities"
              ? location.pathname.startsWith(link.to) &&
                location.pathname !== "/admin/activities/new"
              : location.pathname === link.to ||
                (link.to === "/activities" &&
                  location.pathname.startsWith("/activities/"));
          return (
            <Tooltip
              key={link.to}
              title={collapsed && !inDrawer ? link.label : undefined}
              placement="right"
            >
              <NavLink
                to={link.to}
                end
                className={`side-link ${active ? "active" : ""}`}
                aria-label={link.label}
                aria-current={active ? "page" : undefined}
                onClick={() => setMobileOpen(false)}
              >
                {link.icon}
                <span
                  className={collapsed && !inDrawer ? "visually-hidden" : ""}
                >
                  {link.label}
                </span>
              </NavLink>
            </Tooltip>
          );
        })}
      </nav>
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="site-header">
        <Logo />
        <Button
          className="desktop-toggle"
          type="text"
          aria-label={collapsed ? "展开导航" : "收起导航"}
          icon={
            collapsed ? (
              <MenuUnfoldOutlined aria-hidden="true" />
            ) : (
              <MenuFoldOutlined aria-hidden="true" />
            )
          }
          onClick={() => setCollapsed((value) => !value)}
        />
        <Button
          className="mobile-toggle"
          type="text"
          aria-label="打开导航"
          icon={<MenuUnfoldOutlined aria-hidden="true" />}
          onClick={() => setMobileOpen(true)}
        />
        <span className="header-caption">活动报名平台</span>
        <div className="header-actions">
          {auth.loading ? (
            <Spin size="small" />
          ) : auth.user ? (
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "role",
                    disabled: true,
                    label:
                      auth.user.role === "ADMIN" ? "活动组织者" : "活动参与者",
                  },
                  {
                    key: "mine",
                    icon: <TeamOutlined aria-hidden="true" />,
                    label: "我的报名",
                  },
                  { type: "divider" },
                  {
                    key: "logout",
                    icon: <LogoutOutlined aria-hidden="true" />,
                    label: loggingOut ? "正在退出…" : "退出登录",
                    disabled: loggingOut,
                  },
                ],
                onClick: ({ key }) => {
                  if (key === "logout") void logout();
                  if (key === "mine") navigate("/my-registrations");
                },
              }}
            >
              <button
                className="user-menu"
                aria-label={`账号菜单，${auth.user.displayName}`}
              >
                <Avatar size={28}>{auth.user.displayName.slice(0, 1)}</Avatar>
                <span>{auth.user.displayName}</span>
                <DownOutlined aria-hidden="true" />
              </button>
            </Dropdown>
          ) : (
            <Link to="/login">
              <Button type="primary">登录 / 体验</Button>
            </Link>
          )}
        </div>
      </header>
      <div className="workspace">
        <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
          {navigation()}
          <div className="sidebar-footnote">
            {!collapsed && "活动时间均为北京时间"}
          </div>
        </aside>
        <div className="content-shell">
          <main id="main-content" ref={mainRef} tabIndex={-1}>
            <Outlet />
          </main>
          <footer className="site-footer">集会 Gather · 活动报名平台</footer>
        </div>
      </div>
      <Drawer
        title="集会 Gather"
        placement="left"
        size={260}
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        className="mobile-navigation"
      >
        {navigation(true)}
      </Drawer>
    </div>
  );
}
