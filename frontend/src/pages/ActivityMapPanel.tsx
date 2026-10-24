import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, List, Space, Spin } from "antd";
import { useLocation } from "react-router";
import { api, errorMessage } from "../api";
import { useAuth } from "../auth";
import { enabledMapsConfig, MapOperationGate, selectedActivityLocation } from "../activityMap";
import type { ActivityLocationDraft } from "../activityMap";
import { createActivityMap, loadAmapSdk } from "../amapAdapter";
import type { ActivityMapHandle, MapPlace } from "../amapAdapter";
import type { ActivityMapDialogProps } from "./ActivityMapDialog";
import type { LocationPoint } from "../types";

export default function ActivityMapPanel(props: ActivityMapDialogProps) {
  const auth = useAuth(), route = useLocation();
  const generation = auth.captureAuthenticationRequest();
  const identity = `${route.pathname}${route.search}:${generation}:${props.scope}`;
  const liveIdentity = useRef(identity); liveIdentity.current = identity;
  const callbacks = useRef(props); callbacks.current = props;
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<ActivityMapHandle | null>(null);
  const operations = useRef<MapOperationGate | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [unconfigured, setUnconfigured] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [searched, setSearched] = useState(false);
  const [places, setPlaces] = useState<MapPlace[]>([]);
  const [keyword, setKeyword] = useState(props.initial.location);
  const [candidate, setCandidate] = useState<ActivityLocationDraft | null>(props.initial.locationPoint ? props.initial : null);
  const [address, setAddress] = useState(props.initial.location);

  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && liveIdentity.current === identity && auth.isCurrentAuthenticationRequest(generation);
    const gate = new MapOperationGate(current); operations.current = gate;
    const unsubscribe = auth.subscribeAuthentication(() => {
      controller.abort(); gate.dispose(); handle.current?.destroy(); handle.current = null;
      callbacks.current.onClose();
    });
    setLoading(true); setReady(false); setLoadError(null); setUnconfigured(false);
    async function open() {
      try {
        const config = await api.mapsConfig(controller.signal);
        if (!current()) return;
        if (!enabledMapsConfig(config)) { setUnconfigured(true); return; }
        const sdk = await loadAmapSdk(config, controller.signal, retry > 0);
        if (!current() || !container.current) return;
        handle.current = createActivityMap(sdk, container.current, props.initial.locationPoint,
          props.readonly ? undefined : point => { if (current()) void reverse(point, gate); });
        setReady(true);
      } catch (error) { if (current()) setLoadError(errorMessage(error)); }
      finally { if (current()) setLoading(false); }
    }
    void open();
    return () => {
      controller.abort(); gate.dispose(); unsubscribe();
      handle.current?.destroy(); handle.current = null;
      if (operations.current === gate) operations.current = null;
    };
    // initial values belong to this dialog round; callback refs do not restart SDK work.
  }, [identity, generation, retry]);

  async function reverse(point: LocationPoint, gate: MapOperationGate) {
    const map = handle.current;
    if (!map) return;
    const ticket = gate.begin(); setPending(true); setOperationError(null); setCandidate(null); setAddress("");
    try {
      const place = await map.reverse(point);
      if (!gate.isCurrent(ticket)) return;
      setCandidate(place); setAddress(place.location); map.setPoint(place.locationPoint);
    } catch (error) { if (gate.isCurrent(ticket)) setOperationError(errorMessage(error)); }
    finally { if (gate.isCurrent(ticket)) setPending(false); }
  }

  async function search() {
    const map = handle.current, gate = operations.current, text = keyword.trim();
    if (!map || !gate || !text) return;
    const ticket = gate.begin(); setPending(true); setOperationError(null); setSearched(false);
    try {
      const results = await map.search(text);
      if (!gate.isCurrent(ticket)) return;
      setPlaces(results); setSearched(true);
    } catch (error) { if (gate.isCurrent(ticket)) { setPlaces([]); setOperationError(errorMessage(error)); } }
    finally { if (gate.isCurrent(ticket)) setPending(false); }
  }

  function select(place: MapPlace) {
    const gate = operations.current;
    if (!gate || !gate.isCurrent(gate.begin())) return;
    setPending(false); setOperationError(null); setCandidate(place); setAddress(place.location);
    handle.current?.setPoint(place.locationPoint);
  }

  function confirm() {
    const gate = operations.current;
    if (!gate || !candidate || !ready || pending || !gate.isCurrent(gate.begin())) return;
    try { callbacks.current.onConfirm?.(selectedActivityLocation(address, candidate.locationPoint)); }
    catch (error) { setOperationError(errorMessage(error)); }
  }

  return <div className="activity-map-panel">
    {loading && <div role="status" className="activity-map-loading"><Spin /> 正在加载地图…</div>}
    {unconfigured && <Alert type="info" showIcon title="地图暂未配置"
      description={props.readonly ? "可关闭此窗口，使用“在高德查看 / 导航”查看活动位置。" :
        "管理员尚未配置高德地图服务。你仍可手动填写地点并发布，地图位置可稍后编辑。"} />}
    {loadError && <Alert type="error" showIcon title={props.readonly ? "地图暂时无法显示，可重试或使用高德导航链接。" : loadError}
      action={<Button onClick={() => setRetry(value => value + 1)}>重试地图加载</Button>} />}
    {!props.readonly && ready && <Input.Search aria-label="搜索地图地点" value={keyword} maxLength={200}
      onChange={event => {
        operations.current?.begin(); setPending(false); setSearched(false); setPlaces([]); setOperationError(null); setKeyword(event.target.value);
      }} onSearch={() => void search()} enterButton={<Button type="primary" aria-label="搜索地点">搜索地点</Button>} loading={pending}
      placeholder="输入场地名称或地址，点击搜索" />}
    <div ref={container} className="activity-map-canvas" role="region" aria-label="高德地图"
      style={{ display: unconfigured || loadError ? "none" : "block", visibility: ready ? "visible" : "hidden" }} />
    {operationError && <Alert type="error" showIcon title={operationError} />}
    {!props.readonly && ready && <>
      <p className="metadata">搜索后选择结果，或点击地图选点。确认前不会修改活动地点。</p>
      {searched && <List size="small" bordered aria-label="地点搜索结果" locale={{ emptyText: "没有匹配地点，请调整关键词或点击地图选点。" }}
        dataSource={places} renderItem={(place, index) => <List.Item key={`${place.locationPoint.longitude}:${place.locationPoint.latitude}:${index}`}>
          <Button type="link" className="activity-map-place" onClick={() => select(place)}>{place.location}</Button>
        </List.Item>} />}
      {candidate && <div className="activity-map-candidate">
        <label htmlFor="map-selected-address">选中地点（可补充楼层、房间）</label>
        <Input id="map-selected-address" value={address} maxLength={200} showCount onChange={event => setAddress(event.target.value)} />
        <p className="metadata">经度 {candidate.locationPoint!.longitude}，纬度 {candidate.locationPoint!.latitude}（GCJ-02）</p>
      </div>}
    </>}
    <Space className="activity-map-actions" wrap>
      {!props.readonly && <Button type="primary" disabled={!ready || !candidate || pending || !address.trim()} onClick={confirm}>确认使用此地点</Button>}
      <Button onClick={props.onClose}>{props.readonly ? "关闭地图" : "取消选点"}</Button>
    </Space>
  </div>;
}
