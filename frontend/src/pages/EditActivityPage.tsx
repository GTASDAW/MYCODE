import { useEffect } from "react";
import { Alert, App as AntApp, Button, Card, Form, Input, Select } from "antd";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { canManageActivity } from "../activityLifecycle";
import { ActivityCancellationNotice, ErrorState, LoadingState, PageHeading } from "../components";
import { formatActivityEnd, formatDate, formatRegistrationDeadline, formatTime } from "../date";
import { useActivityClock } from "../useActivityClock";
import type { ActivityDetails } from "../types";
import { useActivityMutation } from "./useActivityMutation";
import { activityCategoryOptions } from "../activityCategory";
import type { ActivityCategory } from "../types";
import { useAdminRead } from "./useAdminRead";
import { ActivityCoverEditor } from "./ActivityCoverEditor";
import { ActivityLocationField } from "./ActivityLocationField";
import { copyLocationPoint } from "../activityMap";

export function EditActivityRoute() {
  const { id } = useParams();
  const auth = useAuth();
  const account = auth.captureAccountRequest();
  return <EditActivityPage key={`${id}:${account?.userId}:${account?.generation}`} />;
}

function EditActivityPage() {
  const { id = "" } = useParams();
  const resource = useAdminRead(signal => api.activity(id, signal), `activity-edit:${id}`);
  const [form] = Form.useForm<ActivityDetails>();
  const mutation = useActivityMutation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const activity = resource.data;
  useActivityClock([activity ?? undefined]);
  useEffect(() => {
    if (activity) form.setFieldsValue({ title: activity.title, description: activity.description, location: activity.location,
      locationPoint: copyLocationPoint(activity.locationPoint), category: activity.category });
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
          locationPoint: copyLocationPoint(values.locationPoint),
          category: values.category,
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
      <PageHeading title="编辑活动" section="活动管理" description="活动开始前可修改封面、标题、介绍、地点和分类。开始、结束、报名截止时间与名额发布后固定。" />
      {mutation.error && <Alert className="form-alert" type="error" showIcon title={mutation.error} />}
      {resource.loading ? <LoadingState /> : resource.error ? (
        <ErrorState error={resource.error} retry={resource.retry} />
      ) : activity && (
        <>
        <ActivityCoverEditor activity={activity} mutation={mutation} />
        <Card title="基本信息" className="create-form-panel">
          <ActivityCancellationNotice activity={activity} />
          {!activity.cancelled && !canManageActivity(activity) && (
            <Alert className="form-alert" type="info" showIcon title="活动已开始，不能编辑" />
          )}
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
            <ActivityLocationField disabled={mutation.busy || !canManageActivity(activity)} />
            <Form.Item name="category" label="活动分类" rules={[{ required: true, message: "请选择活动分类" }]}>
              <Select<ActivityCategory> aria-label="活动分类" options={activityCategoryOptions} />
            </Form.Item>
            <div className="form-two-columns">
              <Form.Item label="开始时间（北京时间）" extra="开始时间发布后固定。">
                <Input readOnly value={`${formatDate(activity.startsAt)} ${formatTime(activity.startsAt)}`} aria-label="开始时间（北京时间）" />
              </Form.Item>
              <Form.Item label="结束时间（北京时间）" extra="结束时间发布后固定。">
                <Input readOnly value={formatActivityEnd(activity.endsAt)} aria-label="结束时间（北京时间）" />
              </Form.Item>
            </div>
            <div className="form-two-columns">
              <Form.Item label="报名截止时间（北京时间）" extra="报名截止时间发布后固定。">
                <Input readOnly value={formatRegistrationDeadline(activity.registrationDeadline)} aria-label="报名截止时间（北京时间）" />
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
        </>
      )}
    </div>
  );
}
