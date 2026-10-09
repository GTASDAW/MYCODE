import { useEffect } from "react";
import { Alert, App as AntApp, Button, Card, Form, Input } from "antd";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { canManageActivity } from "../activityLifecycle";
import { ActivityCancellationNotice, ErrorState, LoadingState, PageHeading } from "../components";
import { formatDate, formatTime } from "../date";
import type { ActivityDetails } from "../types";
import { useAuthenticatedResource } from "./useAuthenticatedResource";
import { useActivityMutation } from "./useActivityMutation";

export function EditActivityRoute() {
  const { id } = useParams();
  const { user } = useAuth();
  return <EditActivityPage key={`${id}:${user?.id}`} />;
}

function EditActivityPage() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const resource = useAuthenticatedResource((signal) => api.activity(id, signal), [id, user?.id]);
  const [form] = Form.useForm<ActivityDetails>();
  const mutation = useActivityMutation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const activity = resource.data;
  useEffect(() => {
    if (activity) form.setFieldsValue({ title: activity.title, description: activity.description, location: activity.location });
  }, [activity, form]);

  async function submit(values: ActivityDetails) {
    if (!activity) return;
    await mutation.run(
      (signal) => {
        if (!canManageActivity(activity))
          throw new Error("活动已关闭，不能编辑。请重新加载活动信息。");
        return api.updateActivity(activity.id, {
          title: values.title.trim(),
          description: values.description.trim(),
          location: values.location.trim(),
        }, signal);
      },
      (updated) => {
        message.success("活动信息已更新");
        navigate(`/activities/${updated.id}`);
      },
    );
  }

  return (
    <div className="page-container">
      <PageHeading title="编辑活动" section="活动管理" description="活动开始前可修改标题、介绍和地点。开始时间与名额发布后固定。" />
      {resource.loading ? <LoadingState /> : resource.error ? (
        <ErrorState error={resource.error} retry={resource.retry} />
      ) : activity && (
        <Card title="基本信息" className="create-form-panel">
          <ActivityCancellationNotice activity={activity} />
          {!activity.cancelled && !canManageActivity(activity) && (
            <Alert className="form-alert" type="info" showIcon title="活动已开始，不能编辑" />
          )}
          {mutation.error && <Alert className="form-alert" type="error" showIcon title={mutation.error} />}
          <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} disabled={mutation.busy || !canManageActivity(activity)}>
            <Form.Item name="title" label="活动标题" rules={[
              { required: true, whitespace: true, message: "请输入活动标题" },
              { max: 100, message: "标题最多 100 个字符" },
            ]}>
              <Input maxLength={100} showCount />
            </Form.Item>
            <Form.Item name="description" label="活动介绍" rules={[
              { required: true, whitespace: true, message: "请输入活动介绍" },
              { max: 10000, message: "活动介绍最多 10000 个字符" },
            ]}>
              <Input.TextArea rows={6} maxLength={10000} showCount />
            </Form.Item>
            <Form.Item name="location" label="活动地点" rules={[
              { required: true, whitespace: true, message: "请输入活动地点" },
              { max: 200, message: "地点最多 200 个字符" },
            ]}>
              <Input maxLength={200} />
            </Form.Item>
            <div className="form-two-columns">
              <Form.Item label="开始时间（北京时间）" extra="开始时间发布后固定。">
                <Input readOnly value={`${formatDate(activity.startsAt)} ${formatTime(activity.startsAt)}`} aria-label="开始时间（北京时间）" />
              </Form.Item>
              <Form.Item label="报名名额" extra="活动发布后，名额数量固定。">
                <Input readOnly value={`${activity.capacity} 人`} aria-label="报名名额" />
              </Form.Item>
            </div>
            <div className="form-submit-row">
              <Button type="primary" htmlType="submit" loading={mutation.busy} aria-label="保存修改" aria-busy={mutation.busy}>保存修改</Button>
              <Link to={`/activities/${activity.id}`}><Button disabled={false}>返回活动详情</Button></Link>
            </div>
          </Form>
        </Card>
      )}
    </div>
  );
}
