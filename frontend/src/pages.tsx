import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  App as AntApp,
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Result,
  Tag,
} from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CalendarOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  EnvironmentOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { api, ApiError, errorMessage } from "./api";
import { useAuth } from "./auth";
import {
  ActivityCard,
  ActivityStatus,
  DateBadge,
  EmptyState,
  ErrorState,
  LoadingState,
} from "./components";
import {
  beijingInputMin,
  beijingInputToIso,
  formatDate,
  formatTime,
} from "./date";
import { useResource } from "./useResource";

export function ProtectedRoute({
  children,
  admin = false,
}: {
  children: ReactNode;
  admin?: boolean;
}) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading)
    return (
      <div className="page-container">
        <LoadingState />
      </div>
    );
  if (auth.error)
    return (
      <div className="page-container">
        <ErrorState
          error={new Error(auth.error)}
          retry={() => void auth.reload()}
        />
      </div>
    );
  if (!auth.user)
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (admin && auth.user.role !== "ADMIN")
    return (
      <Result
        status="403"
        title="此页面仅对活动组织者开放"
        subTitle="你可以浏览活动并报名，或切换到组织者演示账号。"
        extra={
          <Link to="/activities">
            <Button type="primary">发现活动</Button>
          </Link>
        }
      />
    );
  return children;
}

export function ActivitiesPage() {
  const { user } = useAuth();
  const resource = useResource(api.activities, [user?.id]);
  const activities = resource.data ?? [];
  const upcoming = activities.filter((activity) => !activity.closed);
  const next = upcoming
    .slice()
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
  const available = upcoming.reduce(
    (total, activity) =>
      total + Math.max(0, activity.capacity - activity.registeredCount),
    0,
  );

  return (
    <div className="page-container discovery-page">
      <section className="discovery-hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="small-dot" /> GATHER · 活动报名
          </span>
          <h1>发现活动</h1>
          <p>浏览近期活动，选择感兴趣的一场参与。</p>
        </div>
        <div className="hero-feature">
          <div className="hero-orbit" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <span className="feature-label">下一场活动</span>
          {resource.loading ? (
            <div className="feature-loading">正在加载活动…</div>
          ) : resource.error ? (
            <>
              <h2>活动暂时无法加载</h2>
              <p>请在下方重新加载活动列表。</p>
            </>
          ) : next ? (
            <>
              <h2>{next.title}</h2>
              <p>
                <CalendarOutlined aria-hidden="true" /> {formatDate(next.startsAt, false)} ·{" "}
                {formatTime(next.startsAt)}
              </p>
              <Link to={`/activities/${next.id}`}>
                了解这场活动 <ArrowRightOutlined aria-hidden="true" />
              </Link>
            </>
          ) : (
            <>
              <h2>暂无即将开始的活动</h2>
              <p>新的活动发布后会显示在这里。</p>
            </>
          )}
        </div>
      </section>
      <div className="discovery-stats" aria-label="活动概览">
        <div>
          <CalendarOutlined aria-hidden="true" />
          <span>
            <strong>
              {resource.loading || resource.error ? "—" : upcoming.length}
            </strong>{" "}
            场即将开始的活动
          </span>
        </div>
        <div>
          <UserOutlined aria-hidden="true" />
          <span>
            <strong>
              {resource.loading || resource.error ? "—" : available}
            </strong>{" "}
            个可报名名额
          </span>
        </div>
      </div>
      <section className="activities-section" id="activity-list">
        <div className="section-heading">
          <div>
            <h2>全部活动</h2>
          </div>
          {!resource.loading && !resource.error && (
            <span className="list-count">共 {activities.length} 场活动</span>
          )}
        </div>
        {resource.loading ? (
          <LoadingState cards />
        ) : resource.error ? (
          <ErrorState error={resource.error} retry={resource.retry} />
        ) : activities.length === 0 ? (
          <EmptyState
            title="还没有发布的活动"
            description="活动发布后会显示在这里。"
            action={
              user?.role === "ADMIN" ? (
                <Link to="/admin/activities/new">
                  <Button type="primary" icon={<PlusOutlined aria-hidden="true" />}>
                    发布第一场活动
                  </Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="activity-grid">
            {activities.map((activity, i) => (
              <ActivityCard key={activity.id} activity={activity} index={i} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function ActivityDetailRoute() {
  const { id } = useParams();
  const { user } = useAuth();
  return <ActivityDetailPage key={`${id}:${user?.id ?? "guest"}`} />;
}

function ActivityDetailPage() {
  const { id = "" } = useParams();
  const auth = useAuth();
  const resource = useResource(
    (signal) => api.activity(id, signal),
    [id, auth.user?.id],
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const activity = resource.data;

  async function mutate(cancel: boolean) {
    if (!activity) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await (cancel
        ? api.cancel(activity.id)
        : api.register(activity.id));
      if (!mounted.current) return;
      resource.setData(updated);
      message.success(cancel ? "已取消报名" : "报名成功");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 401) {
        auth.expire();
        navigate("/login", {
          state: {
            from: `/activities/${id}`,
            notice: "登录已过期，请重新登录后继续。",
          },
        });
      } else {
        setActionError(errorMessage(error));
        // Refresh a potentially stale capacity or deadline after a rejected operation.
        if (error instanceof ApiError && error.status === 409) {
          try {
            const updated = await api.activity(id);
            if (mounted.current) resource.setData(updated);
          } catch {
            /* Keep the original, visible action error. */
          }
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (resource.loading)
    return (
      <div className="page-container">
        <LoadingState />
      </div>
    );
  if (resource.error)
    return (
      <div className="page-container">
        <BackLink />
        <ErrorState error={resource.error} retry={resource.retry} />
      </div>
    );
  if (!activity) return null;
  const registered = activity.registrationStatus === "ACTIVE";
  const cancelled = activity.registrationStatus === "CANCELLED";
  const remaining = Math.max(0, activity.capacity - activity.registeredCount);
  const closed = activity.closed || Date.parse(activity.startsAt) <= Date.now();

  return (
    <div className="page-container detail-page">
      <BackLink />
      <div className="detail-layout">
        <article className="detail-content">
          <div className="detail-heading">
            <DateBadge startsAt={activity.startsAt} large />
            <div>
              <span className="eyebrow muted">活动详情</span>
              <div className="detail-status">
                <ActivityStatus activity={activity} />
                {registered && closed && <Tag color="green">已报名</Tag>}
              </div>
              <h1>{activity.title}</h1>
            </div>
          </div>
          <div className="detail-facts">
            <div>
              <CalendarOutlined aria-hidden="true" />
              <span>
                <small>活动时间</small>
                <strong>
                  {formatDate(activity.startsAt)} ·{" "}
                  {formatTime(activity.startsAt)}
                </strong>
                <em>北京时间</em>
              </span>
            </div>
            <div>
              <EnvironmentOutlined aria-hidden="true" />
              <span>
                <small>活动地点</small>
                <strong>{activity.location}</strong>
              </span>
            </div>
          </div>
          <section className="detail-description">
            <h2>关于这场活动</h2>
            <p>{activity.description}</p>
          </section>
          <section className="participation-note">
            <SafetyCertificateOutlined aria-hidden="true" />
            <div>
              <h3>参与小提示</h3>
              <p>
                报名后，你可以在「我的报名」查看记录。活动开始前可以取消，开始后将关闭报名和取消。
              </p>
            </div>
          </section>
        </article>
        <aside className="registration-panel" aria-label="活动报名">
          <span className="eyebrow muted">活动报名</span>
          <h2>
            {registered
              ? "你的名额已确认"
              : closed
                ? "活动已经开始"
                : remaining === 0
                  ? "本场名额已满"
                  : "报名参加活动"}
          </h2>
          <div className="registration-number">
            <strong>{activity.registeredCount}</strong>
            <span>/ {activity.capacity} 人已报名</span>
          </div>
          <div className="seat-progress">
            <span
              style={{
                width: `${Math.min(100, (activity.registeredCount / activity.capacity) * 100)}%`,
              }}
            />
          </div>
          <p className="remaining-text">
            {closed ? (
              "报名与取消已关闭"
            ) : remaining ? (
              <>
                还有 <strong>{remaining}</strong> 个名额
              </>
            ) : (
              "暂无可报名名额"
            )}
          </p>
          {actionError && (
            <Alert
              className="action-error"
              type="error"
              showIcon
              title={actionError}
            />
          )}
          {registered && (
            <div className="registered-notice">
              <CheckCircleFilled aria-hidden="true" />
              <div>
                <strong>已成功报名</strong>
                <p>期待与你在活动现场见面。</p>
              </div>
            </div>
          )}
          {cancelled && !registered && (
            <p className="cancelled-notice">
              你之前取消了报名，有空位时可以重新加入。
            </p>
          )}
          {closed ? (
            <Button size="large" block disabled>
              活动已开始
            </Button>
          ) : auth.loading ? (
            <Button size="large" block loading>
              正在确认登录状态
            </Button>
          ) : !auth.user ? (
            <Link to="/login" state={{ from: `/activities/${id}` }}>
              <Button size="large" block type="primary">
                登录后报名 <ArrowRightOutlined aria-hidden="true" />
              </Button>
            </Link>
          ) : registered ? (
            <Popconfirm
              title="确认取消这场活动的报名？"
              description="取消后名额将释放，重新报名需要还有空位。"
              okText="确认取消"
              cancelText="保留名额"
              onConfirm={() => mutate(true)}
              disabled={busy}
            >
              <Button size="large" block loading={busy}>
                取消报名
              </Button>
            </Popconfirm>
          ) : (
            <Button
              type="primary"
              size="large"
              block
              disabled={remaining === 0}
              loading={busy}
              onClick={() => void mutate(false)}
            >
              {remaining === 0
                ? "名额已满"
                : cancelled
                  ? "重新报名"
                  : "立即报名"}
              {remaining > 0 && <ArrowRightOutlined aria-hidden="true" />}
            </Button>
          )}
          <div className="panel-footnote">
            <ClockCircleOutlined aria-hidden="true" />
            <span>活动开始前均可取消</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link className="back-link" to="/activities">
      <ArrowLeftOutlined aria-hidden="true" /> 返回全部活动
    </Link>
  );
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm<{ username: string; password: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = location.state as { from?: string; notice?: string } | null;
  const destination =
    state?.from?.startsWith("/") &&
    !state.from.startsWith("//") &&
    state.from !== "/login"
      ? state.from
      : "/activities";

  if (auth.loading)
    return (
      <div className="page-container">
        <LoadingState />
      </div>
    );
  if (auth.user) return <Navigate to={destination} replace />;

  async function submit(values: { username: string; password: string }) {
    setBusy(true);
    setError(null);
    try {
      await auth.login(values.username.trim(), values.password);
      navigate(destination, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-container login-page">
      <BackLink />
      <div className="login-layout">
        <section className="login-story">
          <span className="eyebrow">GATHER · 活动报名</span>
          <h1>
            登录集会，
            <br />
            参与下一场活动。
          </h1>
          <p>
            参与者可以报名、取消和查看记录。
            <br />
            组织者还可以发布新的活动。
          </p>
          <div className="login-art" aria-hidden="true">
            <div />
            <div />
            <div />
            <span>g.</span>
          </div>
          <span className="login-story-bottom">
            集会 Gather · 活动时间均为北京时间
          </span>
        </section>
        <section className="login-form-panel">
          <span className="eyebrow muted">WELCOME TO GATHER</span>
          <h2>欢迎来到集会</h2>
          <p className="form-intro">登录账号，开启你的下一场活动。</p>
          {(state?.notice || auth.error) && (
            <Alert
              className="form-alert"
              type="warning"
              showIcon
              title={state?.notice ?? auth.error}
            />
          )}
          {error && (
            <Alert className="form-alert" type="error" showIcon title={error} />
          )}
          <Form
            form={form}
            layout="vertical"
            onFinish={submit}
            requiredMark={false}
            size="large"
          >
            <Form.Item
              name="username"
              label="账号"
              rules={[
                { required: true, whitespace: true, message: "请输入账号" },
              ]}
            >
              <Input
                autoComplete="username"
                prefix={<UserOutlined aria-hidden="true" />}
                placeholder="输入你的账号"
                maxLength={64}
              />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password
                autoComplete="current-password"
                placeholder="输入密码"
                maxLength={128}
              />
            </Form.Item>
            <Button type="primary" block htmlType="submit" loading={busy}>
              登录 <ArrowRightOutlined aria-hidden="true" />
            </Button>
          </Form>
          <div className="demo-accounts">
            <div className="demo-heading">
              <span>先体验，再探索</span>
              <small>选择演示账号，自动填入表单</small>
            </div>
            <div className="demo-buttons">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  form.setFieldsValue({
                    username: "demo",
                    password: "Demo123!",
                  });
                  setError(null);
                }}
              >
                <UserOutlined aria-hidden="true" />
                <strong>活动参与者</strong>
                <span>报名 · 查看记录</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  form.setFieldsValue({
                    username: "admin",
                    password: "Admin123!",
                  });
                  setError(null);
                }}
              >
                <CalendarOutlined aria-hidden="true" />
                <strong>活动组织者</strong>
                <span>发布 · 参与活动</span>
              </button>
            </div>
            <p>演示账号：demo / Demo123! · admin / Admin123!</p>
          </div>
        </section>
      </div>
    </div>
  );
}

export function MyRegistrationsPage() {
  const auth = useAuth();
  const resource = useResource(api.registrations, [auth.user?.id]);
  const registrations = resource.data ?? [];
  const active = registrations.filter((row) => row.status === "ACTIVE").length;

  return (
    <div className="page-container records-page">
      <div className="page-heading">
        <span className="eyebrow muted">YOUR NEXT GATHERING</span>
        <h1>我的报名</h1>
        <p>你的每一次参与，都记录在这里。</p>
      </div>
      {!resource.loading && !resource.error && registrations.length > 0 && (
        <div className="records-summary">
          <CheckCircleFilled aria-hidden="true" />
          <strong>{active}</strong>
          <span>场已报名活动</span>
          <span className="records-total">
            共 {registrations.length} 条报名记录
          </span>
        </div>
      )}
      {resource.loading ? (
        <LoadingState />
      ) : resource.error ? (
        <ErrorState error={resource.error} retry={resource.retry} />
      ) : registrations.length === 0 ? (
        <EmptyState
          title="你的下一场活动还在等你"
          description="选择一场感兴趣的活动，报名后可以在这里查看。"
          action={
            <Link to="/activities">
              <Button type="primary">
                去发现活动 <ArrowRightOutlined aria-hidden="true" />
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="registration-list">
          {registrations.map(({ id, status, activity }) => (
            <article className="registration-row" key={id}>
              <DateBadge startsAt={activity.startsAt} />
              <div className="registration-row-main">
                <h2>
                  <Link to={`/activities/${activity.id}`}>
                    {activity.title}
                  </Link>
                </h2>
                <p>
                  <CalendarOutlined aria-hidden="true" />
                  {formatDate(activity.startsAt)} ·{" "}
                  {formatTime(activity.startsAt)}
                </p>
                <p>
                  <EnvironmentOutlined aria-hidden="true" />
                  {activity.location}
                </p>
              </div>
              <div className="registration-row-actions">
                <Tag color={status === "ACTIVE" ? "green" : "default"}>
                  {status === "ACTIVE" ? "已报名" : "已取消"}
                </Tag>
                {activity.closed && (
                  <span className="record-closed">活动已开始</span>
                )}
                <Link to={`/activities/${activity.id}`}>
                  查看活动 <ArrowRightOutlined aria-hidden="true" />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

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
      message.success("活动已发布");
      navigate(`/activities/${activity.id}`);
    } catch (err) {
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
      setBusy(false);
    }
  }

  return (
    <div className="page-container create-page">
      <BackLink />
      <div className="page-heading">
        <span className="eyebrow muted">活动组织者</span>
        <h1>发布活动</h1>
        <p>填写活动信息，让参与者了解内容并报名。</p>
      </div>
      <div className="create-layout">
        <section className="create-form-panel">
          {error && (
            <Alert className="form-alert" type="error" showIcon title={error} />
          )}
          <Form<CreateActivityForm>
            layout="vertical"
            requiredMark={false}
            onFinish={submit}
            size="large"
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
              <Input
                maxLength={200}
                prefix={<EnvironmentOutlined aria-hidden="true" />}
                placeholder="填写场地名称和详细地址"
              />
            </Form.Item>
            <div className="form-two-columns">
              <Form.Item
                name="startsAt"
                label="开始时间（北京时间）"
                rules={[
                  { required: true, message: "请选择活动开始时间" },
                  {
                    validator: (_, value: string | undefined) => {
                      if (!value) return Promise.resolve();
                      try {
                        if (Date.parse(beijingInputToIso(value)) > Date.now())
                          return Promise.resolve();
                      } catch {
                        /* Validation below supplies a user-facing message. */
                      }
                      return Promise.reject(
                        new Error("请选择未来的日期和时间"),
                      );
                    },
                  },
                ]}
              >
                <Input
                  type="datetime-local"
                  min={beijingInputMin()}
                  step={60}
                />
              </Form.Item>
              <Form.Item
                name="capacity"
                label="报名名额"
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
                  controls
                  aria-label="报名名额"
                  suffix="人"
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </div>
            <div className="form-submit-row">
              <span>
                <SafetyCertificateOutlined aria-hidden="true" /> 发布后，名额数量固定
              </span>
              <Button
                type="primary"
                htmlType="submit"
                loading={busy}
                icon={<PlusOutlined aria-hidden="true" />}
              >
                发布活动
              </Button>
            </div>
          </Form>
        </section>
        <aside className="create-guide">
          <span className="eyebrow muted">HOST A GOOD GATHERING</span>
          <h2>让参与者更期待</h2>
          <div>
            <span>01</span>
            <h3>清楚介绍活动</h3>
            <p>告诉大家会聊些什么、做些什么，以及谁适合参与。</p>
          </div>
          <div>
            <span>02</span>
            <h3>填写准确的地点</h3>
            <p>详细的地址，让大家能顺利找到活动现场。</p>
          </div>
          <div>
            <span>03</span>
            <h3>预留合适的名额</h3>
            <p>名额发布后固定，请结合场地和活动形式提前规划。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <Result
      status="404"
      title="这条路还没有通向活动"
      subTitle="页面可能已不存在，回到活动列表继续发现。"
      extra={
        <Link to="/activities">
          <Button type="primary">返回活动列表</Button>
        </Link>
      }
    />
  );
}
