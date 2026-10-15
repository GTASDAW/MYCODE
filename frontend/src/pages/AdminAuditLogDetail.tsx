import { Button, Descriptions, Drawer } from "antd";
import { api, ApiError } from "../api";
import { auditActionLabels, auditChangeText, auditFieldLabels, formatAuditDateTime } from "../auditLogPresentation";
import { ErrorState, LoadingState } from "../components";
import { useAdminAuditRead } from "./useAdminAuditRead";

function DetailContent({ id, scope }: { id: number; scope: string }) {
  const resource = useAdminAuditRead(signal => api.adminAuditLog(id, signal), `${scope}:detail:${id}`);
  if (resource.loading) return <LoadingState />;
  if (resource.error) return resource.error instanceof ApiError && resource.error.status === 404
    ? <div role="alert"><p>操作记录不存在或已不可用。</p><Button onClick={resource.retry}>重新加载详情</Button></div>
    : <ErrorState error={resource.error} retry={resource.retry} />;
  const item = resource.data;
  if (!item) return null;
  return <div data-testid="audit-log-detail">
    <p className="audit-snapshot-note metadata">活动、操作人和目标用户的名称均为操作时快照，不随之后改名变化。</p>
    <Descriptions column={1} size="small" bordered items={[
      { key: "id", label: "记录 ID", children: item.id },
      { key: "action", label: "操作类型", children: auditActionLabels[item.action] },
      { key: "time", label: "操作时间（北京时间）", children: formatAuditDateTime(item.occurredAt) },
      { key: "activityId", label: "活动 ID", children: item.activityId },
      { key: "activityTitle", label: "活动名称（操作时快照）", children: item.activityTitle },
      { key: "actorId", label: "操作人 ID", children: item.actorUserId },
      { key: "actorUsername", label: "操作人账号（操作时快照）", children: item.actorUsername },
      { key: "actorName", label: "操作人昵称（操作时快照）", children: item.actorDisplayName },
      { key: "registrationId", label: "报名记录 ID", children: item.registrationId ?? "不适用" },
      { key: "targetUsername", label: "目标用户账号（操作时快照）", children: item.targetUsername ?? "不适用" },
      { key: "targetName", label: "目标用户昵称（操作时快照）", children: item.targetDisplayName ?? "不适用" },
    ]} />
    <h2 className="audit-change-heading">字段变化</h2>
    <div className="audit-changes">
      {item.changes.map(change => <section className="audit-change" key={change.field} data-audit-field={change.field}
        aria-label={auditFieldLabels[change.field]}>
        <h3>{auditFieldLabels[change.field]}</h3>
        <div className="audit-change-values">
          <div><h4>变更前</h4><pre data-testid={`audit-before-${change.field}`}>{auditChangeText(change.field, change.before)}</pre></div>
          <div><h4>变更后</h4><pre data-testid={`audit-after-${change.field}`}>{auditChangeText(change.field, change.after)}</pre></div>
        </div>
      </section>)}
    </div>
  </div>;
}

export function AdminAuditLogDetail({ id, scope, onClose }: {
  id: number | null;
  scope: string;
  onClose: () => void;
}) {
  return <Drawer title="操作记录详情" open={id !== null} onClose={onClose} size={760}
    styles={{ wrapper: { maxWidth: "100vw" } }} destroyOnHidden
    extra={<Button onClick={onClose}>关闭详情</Button>}>
    {id !== null && <DetailContent key={`${scope}:${id}`} id={id} scope={scope} />}
  </Drawer>;
}
