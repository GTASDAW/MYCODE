import { Button, Card, Grid, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { auditActionLabels, formatAuditDateTime } from "../auditLogPresentation";
import type { AdminAuditLog } from "../types";

function ActionTag({ item }: { item: AdminAuditLog }) {
  return <Tag color={item.action === "CANCEL" ? "red" : item.action === "CHECK_IN" ? "green" : "blue"}>
    {auditActionLabels[item.action]}
  </Tag>;
}

export function AdminAuditLogList({ items, onDetail }: {
  items: AdminAuditLog[];
  onDetail: (id: number) => void;
}) {
  const screens = Grid.useBreakpoint();
  const detailButton = (item: AdminAuditLog) => <Button type="link" aria-label={`查看操作记录 ${item.id} 详情`}
    onClick={() => onDetail(item.id)}>查看详情</Button>;
  if (!screens.md) return <div className="audit-mobile-list" aria-label="操作记录列表">
    {items.map(item => <Card key={item.id} size="small" data-audit-id={item.id}
      title={<ActionTag item={item} />} extra={<span className="metadata">记录 ID：{item.id}</span>}>
      <dl className="audit-mobile-metadata">
        <dt>活动名称（操作时快照）</dt><dd>{item.activityTitle}</dd>
        <dt>活动 ID</dt><dd>{item.activityId}</dd>
        <dt>操作人（操作时快照）</dt><dd>{item.actorDisplayName}（{item.actorUsername}） · ID：{item.actorUserId}</dd>
        <dt>操作时间（北京时间）</dt><dd>{formatAuditDateTime(item.occurredAt)}</dd>
        {item.registrationId !== null && <><dt>报名记录 ID</dt><dd>{item.registrationId}</dd></>}
        {item.targetUsername !== null && <><dt>目标用户（操作时快照）</dt><dd>{item.targetDisplayName}（{item.targetUsername}）</dd></>}
      </dl>
      <div className="audit-mobile-actions">{detailButton(item)}</div>
    </Card>)}
  </div>;
  const columns: TableColumnsType<AdminAuditLog> = [
    { title: "记录 ID", dataIndex: "id", width: 100 },
    { title: "操作类型", key: "action", width: 130, render: (_, item) => <ActionTag item={item} /> },
    { title: "活动名称（操作时快照）", key: "activity", width: 230,
      render: (_, item) => <span className="audit-cell">{item.activityTitle}<br /><span className="metadata">活动 ID：{item.activityId}</span></span> },
    { title: "操作人（操作时快照）", key: "actor", width: 210,
      render: (_, item) => <span className="audit-cell">{item.actorDisplayName}（{item.actorUsername}）<br /><span className="metadata">ID：{item.actorUserId}</span></span> },
    { title: "操作时间（北京时间）", dataIndex: "occurredAt", width: 260, render: formatAuditDateTime },
    { title: "目标用户（操作时快照）", key: "target", width: 210,
      render: (_, item) => item.targetUsername === null ? "不适用" :
        <span className="audit-cell">{item.targetDisplayName}（{item.targetUsername}）<br /><span className="metadata">报名记录 ID：{item.registrationId}</span></span> },
    { title: "操作", key: "actions", width: 125, fixed: "right", render: (_, item) => detailButton(item) },
  ];
  return <Table<AdminAuditLog> rowKey="id" columns={columns} dataSource={items} pagination={false}
    scroll={{ x: 1265 }} onRow={item => ({ className: "audit-log-row", "data-audit-id": String(item.id) })} />;
}
