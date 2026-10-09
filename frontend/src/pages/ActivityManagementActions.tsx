import { useState } from "react";
import { Alert, App as AntApp, Button, Form, Input, Modal, Space } from "antd";
import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { canManageActivity, cancellationReasonError } from "../activityLifecycle";
import type { Activity } from "../types";
import { useActivityMutation } from "./useActivityMutation";

export function ActivityManagementActions({
  activity,
  onChanged,
  compact = false,
  disabled = false,
}: {
  activity: Activity;
  onChanged: (activity: Activity) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const { user } = useAuth();
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ reason: string }>();
  const mutation = useActivityMutation();
  if (user?.role !== "ADMIN") return null;
  const manageable = canManageActivity(activity);
  if (!manageable && !open) return null;

  async function cancel(values: { reason: string }) {
    await mutation.run(
      (signal) => {
        if (!canManageActivity(activity))
          throw new Error("活动已开始，不能取消。请重新加载活动信息。");
        return api.cancelActivity(activity.id, values.reason.trim(), signal);
      },
      (updated) => {
        setOpen(false);
        form.resetFields();
        onChanged(updated);
        message.success("活动已取消，报名和候补记录已保留");
      },
    );
  }

  return (
    <>
      {manageable && <Space wrap size="small" className="activity-management-actions">
        <Link to={`/admin/activities/${activity.id}/edit`} aria-disabled={disabled}
          onClick={(event) => { if (disabled) event.preventDefault(); }}>
          {compact ? "编辑活动" : <Button disabled={disabled}>编辑活动</Button>}
        </Link>
        <Button
          danger
          type={compact ? "link" : "default"}
          className={compact ? "table-cancel-action" : undefined}
          disabled={disabled}
          onClick={() => {
            mutation.clearError();
            setOpen(true);
          }}
        >取消活动</Button>
      </Space>}
      <Modal
        title="取消活动"
        open={open}
        onCancel={() => setOpen(false)}
        closable={!mutation.busy}
        keyboard={!mutation.busy}
        maskClosable={false}
        destroyOnHidden
        footer={null}
      >
        <p className="cancel-activity-warning">
          确认取消「{activity.title}」？取消后将关闭报名，所有有效报名和候补都会变为已取消。
          历史记录会保留，活动不能恢复。
        </p>
        {mutation.error && <Alert className="form-alert" type="error" showIcon title={mutation.error} />}
        {!manageable && !mutation.error && <Alert className="form-alert" type="warning" showIcon title="活动已关闭，不能取消。请重新加载活动信息。" />}
        <Form form={form} layout="vertical" requiredMark={false} onFinish={cancel} disabled={mutation.busy || !manageable}>
          <Form.Item name="reason" label="取消原因" extra="1–500 个字符，单行文字；参与者可以查看。" rules={[
            { validator: (_, value: string = "") => {
              const error = cancellationReasonError(value);
              return error ? Promise.reject(new Error(error)) : Promise.resolve();
            } },
          ]}>
            <Input maxLength={500} showCount placeholder="说明取消活动的原因" autoComplete="off" />
          </Form.Item>
          <div className="form-submit-row">
            <Button type="primary" danger htmlType="submit" loading={mutation.busy} aria-label="确认取消活动" aria-busy={mutation.busy}>
              确认取消活动
            </Button>
            <Button onClick={() => setOpen(false)} disabled={mutation.busy}>暂不取消</Button>
          </div>
        </Form>
      </Modal>
    </>
  );
}
