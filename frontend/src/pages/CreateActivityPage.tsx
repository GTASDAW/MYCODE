import { useEffect, useRef, useState } from "react";
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { Link, useNavigate } from "react-router";
import { api, ApiError, errorMessage } from "../api";
import { useAuth } from "../auth";
import { PageHeading } from "../components";
import { beijingInputMin, beijingInputToIso } from "../date";

interface CreateActivityForm {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  capacity: number;
}

export function CreateActivityPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { message } = AntApp.useApp();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit(values: CreateActivityForm) {
    setBusy(true);
    setError(null);
    try {
      const activity = await api.createActivity({
        ...values,
        title: values.title.trim(),
        description: values.description.trim(),
        location: values.location.trim(),
        startsAt: beijingInputToIso(values.startsAt),
      });
      if (!mounted.current) return;
      message.success("活动已发布");
      navigate(`/activities/${activity.id}`);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 401) {
        auth.expire();
        navigate("/login", {
          state: {
            from: "/admin/activities/new",
            notice: "登录已过期，请重新登录后继续。",
          },
        });
      } else setError(errorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="page-container">
      <PageHeading
        title="发布活动"
        section="活动管理"
        description="填写活动信息。发布后名额固定，活动开始时关闭报名与取消。"
      />
      <Card title="基本信息" className="create-form-panel">
        {error && (
          <Alert className="form-alert" type="error" showIcon title={error} />
        )}
        <Form<CreateActivityForm>
          layout="vertical"
          requiredMark={false}
          onFinish={submit}
          initialValues={{ capacity: 20 }}
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
                      if (Date.parse(beijingInputToIso(value)) > Date.now())
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
              loading={busy}
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
    </div>
  );
}
