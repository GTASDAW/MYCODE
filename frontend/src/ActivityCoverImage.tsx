import { useState } from "react";
import { safeActivityCoverUrl } from "./activityCover";
import defaultActivityCover from "./assets/default-activity-cover.svg";

function CoverImage({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="activity-cover">
    {url && !failed ? <img src={url} alt={`${title}的活动封面`} loading="lazy" decoding="async"
      onError={() => setFailed(true)} /> : <div className="activity-cover-placeholder">
      <img className="activity-cover-default-art" src={defaultActivityCover} alt="" aria-hidden="true" decoding="async" />
      {failed && <div className="activity-cover-fallback-status">
        <span>封面暂时无法显示</span>
        <button type="button" onClick={() => setFailed(false)}>重新加载封面</button>
      </div>}
    </div>}
  </div>;
}

export function ActivityCover({ id, url, title }: { id: number; url?: string | null; title: string }) {
  const safeUrl = safeActivityCoverUrl(id, url);
  return <CoverImage key={safeUrl ?? "empty"} url={safeUrl} title={title} />;
}
