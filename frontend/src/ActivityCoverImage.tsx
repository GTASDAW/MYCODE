import { useState } from "react";
import { safeActivityCoverUrl } from "./activityCover";

function CoverImage({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="activity-cover">
    {url && !failed ? <img src={url} alt={`${title}的活动封面`} loading="lazy" decoding="async"
      onError={() => setFailed(true)} /> : <div className="activity-cover-placeholder">
      <span>{failed ? "封面暂时无法显示" : "集会 Gather"}</span>
      {failed && <button type="button" onClick={() => setFailed(false)}>重新加载封面</button>}
    </div>}
  </div>;
}

export function ActivityCover({ id, url, title }: { id: number; url?: string | null; title: string }) {
  const safeUrl = safeActivityCoverUrl(id, url);
  return <CoverImage key={safeUrl ?? "empty"} url={safeUrl} title={title} />;
}
