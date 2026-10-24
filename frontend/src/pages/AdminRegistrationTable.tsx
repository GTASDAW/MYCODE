import { Button, Table, Tag } from "antd";
import type { TableColumnsType, TablePaginationConfig } from "antd";
import { formatDate, formatTime } from "../date";
import { canCheckInRegistration, canCorrectCheckInRegistration, checkInLabel, checkInMethodLabel } from "../registrationCheckIn";
import type { Activity, AdminRegistration } from "../types";

const dateTime = (value: string | null) => value ? `${formatDate(value)} ${formatTime(value)}` : "—";

export function AdminRegistrationTable({ activity, items, loading, busy, pagination, onCheckIn, onCorrectCheckIn }: {
  activity: Activity | undefined;
  items: AdminRegistration[];
  loading: boolean;
  busy: boolean;
  pagination: TablePaginationConfig | false;
  onCheckIn: (registration: AdminRegistration) => void;
  onCorrectCheckIn: (registration: AdminRegistration) => void;
}) {
  const columns: TableColumnsType<AdminRegistration> = [
    { title: "用户名", dataIndex: "username", key: "username", width: 150 },
    { title: "姓名", dataIndex: "displayName", key: "displayName", width: 150 },
    {
      title: "报名状态", dataIndex: "status", key: "status", width: 110,
      render: (value: string) => <Tag color={value === "ACTIVE" ? "green" : value === "WAITING" ? "orange" : "default"}>
        {value === "ACTIVE" ? "已报名" : value === "WAITING" ? "候补中" : "已取消"}
      </Tag>,
    },
    {
      title: "签到状态", key: "checkInStatus", width: 110,
      render: (_, row) => <Tag color={row.status !== "ACTIVE" ? "default" : row.checkedInAt ? "blue" : "orange"}>
        {checkInLabel(row)}
      </Tag>,
    },
    { title: "首次报名时间（北京时间）", dataIndex: "createdAt", key: "createdAt", width: 230, render: dateTime },
    { title: "最近更新时间（北京时间）", dataIndex: "updatedAt", key: "updatedAt", width: 230, render: dateTime },
    { title: "签到时间（北京时间）", dataIndex: "checkedInAt", key: "checkedInAt", width: 230, render: dateTime },
    { title: "签到方式", dataIndex: "checkInMethod", key: "checkInMethod", width: 130, render: checkInMethodLabel },
    {
      title: "签到管理员", key: "checkedInBy", width: 170,
      render: (_, row) => row.checkedInBy === null ? "—" : (
        <span>{row.checkedInByDisplayName}<br /><span className="metadata">ID：{row.checkedInBy}</span></span>
      ),
    },
    {
      title: "操作", key: "actions", fixed: "right", width: 200,
      render: (_, row) => row.status !== "ACTIVE" ? <span className="metadata">不适用</span> : <>
          {!row.checkedInAt && <Button type="link" aria-label={`确认报名 ${row.id} 签到`}
            disabled={busy || loading || !activity || !canCheckInRegistration(activity, row)}
            onClick={() => onCheckIn(row)}>确认签到</Button>}
          <Button type="link" aria-label={`更正报名 ${row.id} 签到`}
            disabled={busy || loading || !activity || !canCorrectCheckInRegistration(activity, row)}
            onClick={() => onCorrectCheckIn(row)}>更正签到</Button>
        </>,
    },
  ];
  return <Table<AdminRegistration> className="roster-table" rowKey="id"
    onRow={(row) => ({ className: "roster-row", "data-registration-id": String(row.id) })}
    columns={columns} dataSource={items} loading={loading} pagination={pagination}
    scroll={{ x: 1810 }} locale={{ emptyText: "暂无符合条件的报名记录" }} />;
}
