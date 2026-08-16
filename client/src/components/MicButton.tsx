import { useDictation } from '../hooks/useDictation';
import { useTranscribeAvailable } from '../hooks/useTranscribeAvailable';
import { fmtElapsed } from '../lib/dictation';

/**
 * Tap-to-record mic for a text composer. Hands transcribed text to `onText`;
 * knows nothing about what the text is for.
 *
 * Two suppressed states, and the difference matters. No engine installed → not
 * rendered at all, because an explanation would be noise on every panel. No
 * secure context → rendered but disabled and labelled, because that is the
 * phone-over-plain-http case this feature exists for, and a silently dead
 * button is the worst outcome there.
 */
export default function MicButton(
  { onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }
) {
  const available = useTranscribeAvailable();
  const { phase, elapsed, error, toggle } = useDictation(onText);

  if (!available) return null;

  const secure = typeof window !== 'undefined' && window.isSecureContext;
  if (!secure) {
    return (
      <button type="button" className="qp-mic" disabled title="needs HTTPS — run `pnpm tunnel`">
        🎙 https only
      </button>
    );
  }

  const busy = phase === 'requesting' || phase === 'transcribing';
  const label =
    phase === 'recording' ? fmtElapsed(elapsed)
    : phase === 'transcribing' ? '…'
    : '🎙';

  return (
    <>
      <button
        type="button"
        className={`qp-mic${phase === 'recording' ? ' rec' : ''}`}
        aria-pressed={phase === 'recording'}
        aria-label={phase === 'recording' ? 'stop recording' : 'record a spoken reply'}
        disabled={disabled || busy}
        onClick={toggle}
      >
        {label}
      </button>
      {error && <span className="qp-note">{error}</span>}
    </>
  );
}
