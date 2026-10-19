import { useLayoutEffect, useRef } from "react";
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { Link, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorState, LoadingState, PageHeading } from "../components";
import { activityEndInputError, beijingInputMin, beijingInputToIso, instantMicroseconds } from "../date";
import { activityCategoryOptions } from "../activityCategory";
import type { ActivityCategory } from "../types";
import { useActivityMutation } from "./useActivityMutation";
import { useAdminRead } from "./useAdminRead";
import { activityCopyDraft, activityCreateRequest, ordinaryActivityCreatePath,
  parseActivityCopySource, readActivityCopySource } from "../activityCopy";
import type { ActivityCreateFormValues } from "../activityCopy";

export function CreateActivityPage() {
  const { pathname, search } = useLocation();
  const auth = useAuth();
  const source = parseActivityCopySource(search);
  const sourceScope = source.kind === "copy" ? `copy:${source.id}` : source.kind;
  const resource = useAdminRead(signal => readActivityCopySource(source, api.activity, signal), `${pathname}:activity-create:${sourceScope}`);
  const account = auth.captureAccountRequest();
  const formScope = `${pathname}:${sourceScope}:${account?.userId}:${account?.generation}`;
  const liveScope = useRef<string | null>(formScope);
  liveScope.current = formScope;
  useLayoutEffect(() => {
    liveScope.current = formScope;
    return () => { if (liveScope.current === formScope) liveScope.current = null; };
  }, [formScope]);
  const invalid = source.kind === "invalid";
  const copying = source.kind === "copy";
  const ready = source.kind === "ordinary" || copying && !resource.loading && !resource.error && !!resource.data;
  const returnPath = pathname + search;

  return (
    <div className="page-container">
      <PageHeading
        title="发布活动"
        section="活动管理"
        description="填写活动信息，可选填结束时间。开始、结束时间与名额发布后固定，活动开始时关闭报名与取消。"
      />
      {source.kind !== "ordinary" && <p><Link to={ordinaryActivityCreatePath}>普通发布</Link></p>}
      {invalid ? <ErrorState error={new Error("复制来源参数无效，请使用唯一的正整数活动编号。")} retry={resource.retry} />
        : copying && resource.loading ? <LoadingState />
          : copying && resource.error ? <ErrorState error={resource.error} retry={resource.retry} />
            : null}
      {ready && <>
        {copying && resource.data && <Alert className="form-alert" type="info" showIcon title="复制活动"
          description={<span>来源活动：{resource.data.title}。发布将创建新活动；请重新填写开始时间，按需填写结束时间，封面发布后另传。</span>} />}
        <ActivityCreateForm key={formScope} scope={formScope} returnPath={returnPath}
          isCurrent={() => liveScope.current === formScope}
          initialValues={copying && resource.data ? activityCopyDraft(resource.data) : { capacity: 20, category: "UNCATEGORIZED" }} />
      </>}
    </div>
  );
}

function ActivityCreateForm({ initialValues, scope, returnPath, isCurrent }: {
  initialValues: Partial<ActivityCreateFormValues>; scope: string; returnPath: string; isCurrent: () => boolean;
}) {
  const navigate = useNavigate();
  const mutation = useActivityMutation({ scope, returnPath, isCurrent });
  const { message } = AntApp.useApp();

  async function submit(values: ActivityCreateFormValues) {
    await mutation.run(signal => api.createActivity(activityCreateRequest(values), signal), activity => {
      message.success("活动已发布");
      navigate(`/activities/${activity.id}`);
    });
  }

  return (
      <Card title="基本信息" className="create-form-panel">
        {mutation.error && (
          <Alert className="form-alert" type="error" showIcon title={mutation.error} />
        )}
        <Form<ActivityCreateFormValues>
          layout="vertical"
          requiredMark={false}
          onFinish={submit}
          initialValues={initialValues}
          disabled={mutation.busy}
        >
          <Form.Item
            name="title"
            label="活动标题"
            rules={[
              { required: true, whitespace: true, message: "请输入活动标题" },
              { max: 100, message: "标题最多 100 个字符" },
            ]}
          >
            <Input
              maxLength={100}
              showCount
              placeholder="用一句话介绍你的活动"
            />
          </Form.Item>
          <Form.Item
            name="description"
            label="活动介绍"
            rules={[
              { required: true, whitespace: true, message: "请输入活动介绍" },
              { max: 10000, message: "活动介绍最多 10000 个字符" },
            ]}
          >
            <Input.TextArea
              rows={6}
              maxLength={10000}
              showCount
              placeholder="介绍活动内容、适合谁参与，以及需要准备什么"
            />
          </Form.Item>
          <Form.Item
            name="location"
            label="活动地点"
            rules={[
              { required: true, whitespace: true, message: "请输入活动地点" },
              { max: 200, message: "地点最多 200 个字符" },
            ]}
          >
            <Input maxLength={200} placeholder="填写场地名称和详细地址" />
          </Form.Item>
          <Form.Item name="category" label="活动分类" rules={[{ required: true, message: "请选择活动分类" }]}>
            <Select<ActivityCategory> aria-label="活动分类" options={activityCategoryOptions} />
          </Form.Item>
          <div className="form-two-columns">
            <Form.Item
              name="startsAt"
              label="开始时间（北京时间）"
              rules={[
                { required: true, message: "请选择活动开始时间" },
                {
                  validator: (_, value?: string) => {
                    if (!value) return Promise.resolve();
                    try {
                      if (instantMicroseconds(beijingInputToIso(value))! > BigInt(Date.now()) * 1000n)
                        return Promise.resolve();
                    } catch {
                      /* The validation message below covers invalid dates. */
                    }
                    return Promise.reject(new Error("请选择未来的日期和时间"));
                  },
                },
              ]}
            >
              <Input type="datetime-local" min={beijingInputMin()} step={60} />
            </Form.Item>
            <Form.Item
              name="endsAt"
              label="结束时间（北京时间，可选）"
              dependencies={["startsAt"]}
              extra="必须晚于开始时间；留空显示未提供。开始与结束时间发布后固定。"
              rules={[({ getFieldValue }) => ({ validator: (_, value?: string) => {
                const error = activityEndInputError(getFieldValue("startsAt"), value);
                return error ? Promise.reject(new Error(error)) : Promise.resolve();
              } })]}
            >
              <Input type="datetime-local" step={60} aria-label="结束时间（北京时间，可选）" />
            </Form.Item>
          </div>
          <div className="form-two-columns">
            <Form.Item
              name="capacity"
              label="报名名额"
              extra="活动发布后，名额数量固定。"
              rules={[
                { required: true, message: "请输入名额" },
                {
                  type: "integer",
                  min: 1,
                  max: 10000,
                  message: "名额为 1–10000 的整数",
                },
              ]}
            >
              <InputNumber
                min={1}
                max={10000}
                precision={0}
                aria-label="报名名额"
                suffix="人"
                style={{ width: "100%" }}
              />
            </Form.Item>
          </div>
          <div className="form-submit-row">
            <Button
              type="primary"
              htmlType="submit"
              loading={mutation.busy}
              aria-label="发布活动"
              aria-busy={mutation.busy}
              icon={<PlusOutlined aria-hidden="true" />}
            >
              发布活动
            </Button>
            <Link to="/admin/activities">
              <Button>返回活动管理</Button>
            </Link>
          </div>
        </Form>
      </Card>
  );
}
