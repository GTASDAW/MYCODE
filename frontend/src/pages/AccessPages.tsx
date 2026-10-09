import type { ReactNode } from "react";
import { Button, Result } from "antd";
import { Link, Navigate, useLocation } from "react-router";
import { useAuth } from "../auth";
import { ErrorState, LoadingState } from "../components";

export function ProtectedRoute({
  children,
  admin = false,
}: {
  children: ReactNode;
  admin?: boolean;
}) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading)
    return (
      <div className="page-container">
        <LoadingState />
      </div>
    );
  if (auth.error)
    return (
      <div className="page-container">
        <ErrorState
          error={new Error(auth.error)}
          retry={() => void auth.reload()}
        />
      </div>
    );
  if (!auth.user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname, notice: auth.notice ?? undefined }}
      />
    );
  if (admin && auth.user.role !== "ADMIN")
    return (
      <Result
        status="403"
        title="此页面仅对活动组织者开放"
        subTitle="你可以浏览活动并报名，或切换到组织者演示账号。"
        extra={
          <Link to="/activities">
            <Button type="primary">发现活动</Button>
          </Link>
        }
      />
    );
  return children;
}

export function NotFoundPage() {
  return (
    <Result
      status="404"
      title="页面不存在"
      subTitle="请检查地址，或返回活动列表。"
      extra={
        <Link to="/activities">
          <Button type="primary">返回活动列表</Button>
        </Link>
      }
    />
  );
}
