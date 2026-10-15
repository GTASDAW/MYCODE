import { Card, Grid, Space, Table } from "antd";
import type { TableColumnsType } from "antd";
import { Link } from "react-router";
import { formatDate, formatTime } from "../date";
import type { AttendanceActivity } from "../types";
import { AttendanceRate } from "./AttendanceRate";

function RosterLink({ item }: { item: AttendanceActivity }) {
  return <Link to={`/admin/activities/${item.id}/registrations`} aria-label={`查看活动 ${item.id} 报名名单`}>报名名单</Link>;
}

export function AttendanceActivityList({ items }: { items: AttendanceActivity[] }) {
  const screens = Grid.useBreakpoint();
  if (!screens.md) return <div className="attendance-mobile-list" aria-label="活动签到比较">
    {items.map(item => <Card key={item.id} size="small" data-attendance-activity-id={item.id}
      title={item.title} extra={<span className="metadata">活动 ID：{item.id}</span>}>
      <p className="metadata">开始时间（北京时间）：{formatDate(item.startsAt)} {formatTime(item.startsAt)}</p>
      <p className="metadata">活动地点：{item.location}</p>
      <p className="metadata">活动名额：{item.capacity}</p>
      <dl className="attendance-mobile-counts">
        <div><dt>有效报名</dt><dd>{item.activeRegistrations} 人次</dd></div>
        <div><dt>已签到</dt><dd>{item.checkedInRegistrations} 人次</dd></div>
        <div><dt>未签到</dt><dd>{item.notCheckedInRegistrations} 人次</dd></div>
      </dl>
      <div className="attendance-mobile-rate"><span>当前签到比例</span><AttendanceRate value={item.checkInRate} /></div>
      <Space className="attendance-mobile-actions"><RosterLink item={item} /></Space>
    </Card>)}
  </div>;
  const columns: TableColumnsType<AttendanceActivity> = [
    { title: "活动名称", key: "activity", width: 230, render: (_, item) => <span className="attendance-cell">
      {item.title}<br /><span className="metadata">活动 ID：{item.id}</span></span> },
    { title: "开始时间（北京时间）", dataIndex: "startsAt", width: 210,
      render: (value: string) => <span>{formatDate(value)}<br /><span className="metadata">{formatTime(value)}</span></span> },
    { title: "活动地点", dataIndex: "location", width: 180, render: (value: string) => <span className="attendance-cell">{value}</span> },
    { title: "活动名额", dataIndex: "capacity", width: 100 },
    { title: "有效报名", dataIndex: "activeRegistrations", width: 100 },
    { title: "已签到", dataIndex: "checkedInRegistrations", width: 100 },
    { title: "未签到", dataIndex: "notCheckedInRegistrations", width: 100 },
    { title: "当前签到比例", dataIndex: "checkInRate", width: 190,
      render: (value: number | null) => <AttendanceRate value={value} /> },
    { title: "操作", key: "actions", width: 115, fixed: "right", render: (_, item) => <RosterLink item={item} /> },
  ];
  return <Table<AttendanceActivity> rowKey="id" columns={columns} dataSource={items} pagination={false}
    scroll={{ x: 1325 }} onRow={item => ({ className: "attendance-activity-row", "data-attendance-activity-id": String(item.id) })} />;
}
