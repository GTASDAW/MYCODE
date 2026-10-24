import { useState } from "react";
import { Button, Space } from "antd";
import { amapMarkerUrl, copyLocationPoint } from "../activityMap";
import { ActivityMapDialog } from "./ActivityMapDialog";
import type { Activity } from "../types";

export function ActivityLocationView({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const point = copyLocationPoint(activity.locationPoint), url = amapMarkerUrl(point, activity.title);
  return <div>
    <div>{activity.location}</div>
    {point && url ? <Space wrap className="activity-location-links">
      <Button size="small" onClick={() => setOpen(true)}>查看地图</Button>
      <a href={url} target="_blank" rel="noopener noreferrer">在高德查看 / 导航</a>
    </Space> : <div className="metadata">未设置地图位置</div>}
    {open && point && <ActivityMapDialog initial={{ location: activity.location, locationPoint: point }}
      scope={`activity:${activity.id}`} readonly onClose={() => setOpen(false)} />}
  </div>;
}
