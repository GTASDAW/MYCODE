import { App as AntApp, Avatar, Button, Dropdown, Spin } from "antd";
import {
  DownOutlined,
  LogoutOutlined,
  PlusOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "./auth";
import { errorMessage } from "./api";
import { Logo } from "./components";
import { useEffect, useRef, useState } from "react";

export function Layout() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntApp.useApp();
  const [loggingOut, setLoggingOut] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    mainRef.current?.focus({ preventScroll: true });
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

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Logo />
          <nav className="desktop-nav" aria-label="主导航">
            <NavLink to="/activities">发现活动</NavLink>
            {auth.user && <NavLink to="/my-registrations">我的报名</NavLink>}
          </nav>
          <div className="header-actions">
            {auth.loading ? (
              <Spin size="small" />
            ) : auth.user ? (
              <>
                {auth.user.role === "ADMIN" && (
                  <Link to="/admin/activities/new" className="create-nav-link">
                    <Button icon={<PlusOutlined aria-hidden="true" />}>发布活动</Button>
                  </Link>
                )}
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      {
                        key: "role",
                        disabled: true,
                        label:
                          auth.user.role === "ADMIN"
                            ? "活动组织者"
                            : "活动参与者",
                      },
                      {
                        key: "mine",
                        icon: <UserOutlined aria-hidden="true" />,
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
                    <Avatar size={32}>
                      {auth.user.displayName.slice(0, 1)}
                    </Avatar>
                    <span>{auth.user.displayName}</span>
                    <DownOutlined aria-hidden="true" />
                  </button>
                </Dropdown>
              </>
            ) : (
              <Link to="/login">
                <Button type="primary">登录 / 体验</Button>
              </Link>
            )}
          </div>
        </div>
        {auth.user && (
          <nav className="mobile-nav" aria-label="移动端主导航">
            <NavLink to="/activities">发现活动</NavLink>
            <NavLink to="/my-registrations">我的报名</NavLink>
            {auth.user.role === "ADMIN" && (
              <NavLink to="/admin/activities/new">发布活动</NavLink>
            )}
          </nav>
        )}
      </header>
      <main id="main-content" ref={mainRef} tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="footer-inner">
          <Logo />
          <p>每一次相遇，都值得期待。</p>
          <span>活动时间均为北京时间</span>
        </div>
      </footer>
    </div>
  );
}
