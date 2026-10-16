import { Component, Suspense } from "react";
import type { ReactNode } from "react";
import { Button, Result } from "antd";
import { Link, useLocation } from "react-router";
import { useAuth } from "./auth";
import { LoadingState } from "./components";
import { pageBoundaryScope, reloadCurrentPage } from "./pageBoundaryPolicy";

interface BoundaryProps {
  scope: string;
  children: ReactNode;
}

interface BoundaryState {
  scope: string;
  failed: boolean;
}

class PageErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { scope: this.props.scope, failed: false };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.scope === state.scope ? null : { scope: props.scope, failed: false };
  }

  render() {
    if (this.state.failed) return <div className="page-container" role="alert" data-testid="page-load-error">
      <Result status="error" title="页面暂时无法打开" subTitle="请重新加载当前页面，或返回活动列表。" extra={[
        <Button key="reload" type="primary" onClick={() => reloadCurrentPage(window.location)}>重新加载当前页面</Button>,
        <Link key="activities" to="/activities"><Button>返回活动列表</Button></Link>,
      ]} />
    </div>;
    return this.props.children;
  }
}

export function PageContentBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const auth = useAuth();
  const scope = pageBoundaryScope(location, auth.captureAuthenticationRequest());
  return <PageErrorBoundary scope={scope}>
    <Suspense key={location.pathname} fallback={<div className="page-container" aria-busy="true" data-testid="page-loading">
      <p role="status">正在打开页面…</p>
      <LoadingState />
    </div>}>
      {children}
    </Suspense>
  </PageErrorBoundary>;
}
