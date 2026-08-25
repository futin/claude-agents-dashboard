import { UsageProfile } from './UsageProfile';

/**
 * The Usage section — what the dashboard has learned about your account usage,
 * and what it predicts from it.
 *
 * Its own rail entry rather than a block inside Analytics: Analytics is about
 * *sessions* (the `/kaizen` report cards), and this is about the *account*. They
 * share no data, no endpoint and no cadence — Analytics re-reads transcripts,
 * this reads a profile that moves once a week.
 *
 * Default export → its own lazy chunk, like every section but Sessions. The
 * obvious next tenant is idea-5's utilization-over-time charts, which read the
 * same `.usage-history.jsonl` this section's profile is learned from.
 */
export default function UsageView() {
  return (
    <div className="usage-section">
      <div className="an-bar">
        <div className="an-title">Usage forecast</div>
        <span className="an-hint">
          the duty cycle behind the weekly projection in the header
        </span>
      </div>
      <UsageProfile />
    </div>
  );
}
