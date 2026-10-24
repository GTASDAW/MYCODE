import { useEffect, useRef, useState } from "react";
import { Button, Form, Input, Space } from "antd";
import { useLocation } from "react-router";
import { useAuth } from "../auth";
import { copyLocationPoint, manualActivityLocation } from "../activityMap";
import type { ActivityLocationDraft } from "../activityMap";
import { ActivityMapDialog } from "./ActivityMapDialog";

function LocationPointControl() { return null; }

export function ActivityLocationField({ disabled = false }: { disabled?: boolean }) {
  const form = Form.useFormInstance(), auth = useAuth(), route = useLocation();
  const point = copyLocationPoint(Form.useWatch("locationPoint", form));
  const scope = `${route.pathname}${route.search}:${auth.captureAuthenticationRequest()}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const revision = useRef(0);
  const [dialog, setDialog] = useState<{ initial: ActivityLocationDraft; revision: number; round: number } | null>(null);
  const round = useRef(0);
  useEffect(() => auth.subscribeAuthentication(() => { revision.current++; setDialog(null); }), [auth.subscribeAuthentication]);
  useEffect(() => () => { revision.current++; }, []);

  function open() {
    setDialog({ initial: { location: form.getFieldValue("location") ?? "", locationPoint: copyLocationPoint(form.getFieldValue("locationPoint")) },
      revision: revision.current, round: ++round.current });
  }

  return <>
    <Form.Item name="location" label="活动地点" rules={[
      { required: true, whitespace: true, message: "请输入活动地点" },
      { max: 200, message: "地点最多 200 个字符" },
    ]} extra="可直接填写地点；地图选点可附上位置，手动修改地点会清除旧位置。">
      <Input maxLength={200} placeholder="填写场地名称和详细地址" onChange={event => {
        revision.current++; form.setFieldsValue(manualActivityLocation(event.target.value));
      }} />
    </Form.Item>
    <Form.Item name="locationPoint" hidden><LocationPointControl /></Form.Item>
    <div className="activity-location-tools">
      <Space wrap>
        <Button disabled={disabled} onClick={open}>地图选点</Button>
        {point && <Button disabled={disabled} onClick={() => { revision.current++; form.setFieldValue("locationPoint", null); }}>清除位置</Button>}
      </Space>
      <p className="metadata" aria-live="polite">{point ? `已选地图位置：经度 ${point.longitude}，纬度 ${point.latitude}（GCJ-02）` : "未设置地图位置，可仅填写文字地点。"}</p>
    </div>
    {dialog && !disabled && <ActivityMapDialog key={dialog.round} initial={dialog.initial} scope={`${scope}:${dialog.round}`}
      onClose={() => setDialog(null)} onConfirm={draft => {
        if (currentScope.current !== scope || dialog.revision !== revision.current || disabled) return;
        revision.current++; form.setFieldsValue(draft); setDialog(null);
      }} />}
  </>;
}
