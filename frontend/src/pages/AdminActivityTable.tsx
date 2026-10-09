import { Space, Table } from "antd";
import type { TableColumnsType, TablePaginationConfig } from "antd";
import { Link } from "react-router";
import { ActivityStatus } from "../components";
import { formatDate, formatTime } from "../date";
import type { Activity } from "../types";
import { ActivityManagementActions } from "./ActivityManagementActions";

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
    width: 350,
    render: (_, row) => (
      <Space size="middle" wrap>
        <Link to={`/activities/${row.id}`}>查看详情</Link>
        <Link to={`/admin/activities/${row.id}/registrations`}>报名名单</Link>
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
  return (
    <Table<Activity>
      rowKey="id"
      columns={columns(onChanged)}
      dataSource={activities}
      loading={loading}
      pagination={pagination}
      scroll={{ x: 1290 }}
      locale={{ emptyText: "暂无符合条件的活动" }}
    />
  );
}
