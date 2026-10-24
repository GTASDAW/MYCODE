import { Component, lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import type { ActivityLocationDraft } from "../activityMap";
import { reloadCurrentPage } from "../pageBoundaryPolicy";

const ActivityMapPanel = lazy(() => import("./ActivityMapPanel"));

class MapContentBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <Alert type="error" showIcon title="地图界面加载失败"
      description="可关闭弹窗继续填写地点，或手动重新加载当前页面。"
      action={<Button onClick={() => reloadCurrentPage(window.location)}>重新加载当前页面</Button>} /> : this.props.children;
  }
}

export interface ActivityMapDialogProps {
  initial: ActivityLocationDraft;
  scope: string;
  readonly?: boolean;
  onClose: () => void;
  onConfirm?: (draft: ActivityLocationDraft) => void;
}

export function ActivityMapDialog(props: ActivityMapDialogProps) {
  return <Modal open title={props.readonly ? "活动地图" : "地图选点"} onCancel={props.onClose} footer={null} width={800} destroyOnHidden>
    <MapContentBoundary>
      <Suspense fallback={<div role="status" className="activity-map-loading"><Spin /> 正在打开地图…</div>}>
        <ActivityMapPanel {...props} />
      </Suspense>
    </MapContentBoundary>
  </Modal>;
}
