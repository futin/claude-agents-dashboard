import { useSchedules } from '../../hooks/useSchedules';

/** Placeholder until the Schedules page lands (Task 14); it already polls, so the route and the hook are exercised end to end. */
export default function SchedulesView() {
  const { data, error } = useSchedules();
  return (
    <div className="mgmt-bar">
      <div className="mgmt-title">Schedules</div>
      <span className="muted">{error && !data ? 'Couldn’t load' : data ? `${data.jobs.length} jobs` : 'Loading…'}</span>
    </div>
  );
}
