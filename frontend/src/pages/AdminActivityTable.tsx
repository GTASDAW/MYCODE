import { Card, Empty, Grid, Pagination, Space, Table } from "antd";
import type { TableColumnsType, TablePaginationConfig } from "antd";
import { Link } from "react-router";
import { ActivityStatus } from "../components";
import { formatDate, formatTime } from "../date";
import type { Activity } from "../types";
import { ActivityManagementActions } from "./ActivityManagementActions";
import { activityAuditLogPath } from "../auditLogQuery";
import { activityCategoryLabel } from "../activityCategory";
import { LoadingState } from "../components";
import "./adminActivityTable.css";

const columns = (onChanged: (activity: Activity) => void): TableColumnsType<Activity> => [
  {
    title: "活动名称",
    dataIndex: "title",
    key: "title",
    width: 260,
    render: (title: string, row) => (
      <Link to={`/activities/${row.id}`}>{title}</Link>
    ),
  },
  { title: "活动分类", dataIndex: "category", key: "category", width: 120,
    render: (value: string) => activityCategoryLabel(value) },
  {
    title: "开始时间（北京时间）",
    dataIndex: "startsAt",
    key: "startsAt",
    width: 240,
    render: (value: string) => (
      <span>
        {formatDate(value)}
        <br />
        <span className="metadata">{formatTime(value)}</span>
      </span>
    ),
  },
  {
    title: "活动地点",
    dataIndex: "location",
    key: "location",
    width: 220,
    ellipsis: true,
  },
  {
    title: "报名人数",
    key: "seats",
    width: 120,
    render: (_, row) => `${row.registeredCount} / ${row.capacity}`,
  },
  {
    title: "状态",
    key: "status",
    width: 100,
    render: (_, row) => <ActivityStatus activity={row} personal={false} />,
  },
  {
    title: "操作",
    key: "actions",
    fixed: "right",
    width: 430,
    render: (_, row) => (
      <Space size="middle" wrap>
        <Link to={`/activities/${row.id}`}>查看详情</Link>
        <Link to={`/admin/activities/${row.id}/registrations`}>报名名单</Link>
        <Link to={activityAuditLogPath(row.id)}>操作记录</Link>
        <ActivityManagementActions activity={row} compact onChanged={onChanged} />
      </Space>
    ),
  },
];

export function AdminActivityTable({
  activities,
  loading,
  pagination,
  onChanged,
}: {
  activities: Activity[];
  loading: boolean;
  pagination: TablePaginationConfig | false;
  onChanged: (activity: Activity) => void;
}) {
  const screens = Grid.useBreakpoint();
  if (!screens.md) return <>
    {loading ? <LoadingState /> : activities.length === 0 ? <Empty description="暂无符合条件的活动" /> :
      <div className="admin-activity-mobile-list" aria-label="活动管理列表">
        {activities.map(activity => <Card size="small" key={activity.id} data-activity-id={activity.id}
          title={<Link to={`/activities/${activity.id}`}>{activity.title}</Link>} extra={<ActivityStatus activity={activity} personal={false} />}>
          <p className="metadata">开始时间（北京时间）：{formatDate(activity.startsAt)} {formatTime(activity.startsAt)}</p>
          <p className="metadata">活动分类：{activityCategoryLabel(activity.category)}</p>
          <p className="metadata">活动地点：{activity.location}</p>
          <p className="metadata">有效报名：{activity.registeredCount} / {activity.capacity}</p>
          <Space wrap size="middle" className="admin-activity-mobile-actions">
            <Link to={`/activities/${activity.id}`}>查看详情</Link>
            <Link to={`/admin/activities/${activity.id}/registrations`}>报名名单</Link>
            <Link to={activityAuditLogPath(activity.id)}>操作记录</Link>
            <ActivityManagementActions activity={activity} compact onChanged={onChanged} />
          </Space>
        </Card>)}
      </div>}
    {pagination && <Pagination {...pagination} responsive className="admin-activity-mobile-pagination" />}
  </>;
  return (
    <Table<Activity>
      rowKey="id"
      onRow={activity => ({ className: "admin-activity-row", "data-activity-id": String(activity.id) })}
      columns={columns(onChanged)}
      dataSource={activities}
      loading={loading}
      pagination={pagination}
      scroll={{ x: 1490 }}
      locale={{ emptyText: "暂无符合条件的活动" }}
    />
  );
}
