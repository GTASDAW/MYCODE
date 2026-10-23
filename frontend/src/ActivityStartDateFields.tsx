import { Input } from "antd";
import { activityStartDateMax, activityStartDateMin, activityStartDateRangeError,
  invalidActivityStartDateMessage } from "./activityStartDate";

export function ActivityStartDateFields({ prefix, from, to, error, onFromChange, onToChange, onError }: {
  prefix: string;
  from: string;
  to: string;
  error: string | null;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onError: (error: string | null) => void;
}) {
  const hintId = `${prefix}-date-hint`;
  const errorId = `${prefix}-date-error`;
  const describedBy = `${hintId}${error ? ` ${errorId}` : ""}`;
  const invalid = (event: React.InvalidEvent<HTMLInputElement>) => {
    event.preventDefault();
    onError(activityStartDateRangeError(from, to) ?? invalidActivityStartDateMessage);
  };
  return <>
    <div className="filter-field filter-date">
      <label htmlFor={`${prefix}-date-from`}>开始日期（起）</label>
      <Input id={`${prefix}-date-from`} type="date" aria-label="开始日期（起）" aria-describedby={describedBy}
        aria-invalid={!!error} min={activityStartDateMin} max={activityStartDateMax} value={from}
        status={error ? "error" : undefined} onInvalid={invalid}
        onChange={event => { onError(null); onFromChange(event.target.value); }} />
    </div>
    <div className="filter-field filter-date">
      <label htmlFor={`${prefix}-date-to`}>开始日期（止）</label>
      <Input id={`${prefix}-date-to`} type="date" aria-label="开始日期（止）" aria-describedby={describedBy}
        aria-invalid={!!error} min={activityStartDateMin} max={activityStartDateMax} value={to}
        status={error ? "error" : undefined} onInvalid={invalid}
        onChange={event => { onError(null); onToChange(event.target.value); }} />
    </div>
    <span id={hintId} className="filter-note">按北京时间，包含首尾日期</span>
    {error && <div id={errorId} className="filter-date-error" role="alert">{error}</div>}
  </>;
}
