import { useCallback, useEffect, useRef, useState } from 'react';

import { pickMimeType } from '../lib/dictation';
import { usePersistedState } from './usePersistedState';
import type { TranscribeResponse } from '../../../shared/types';

/** Hard ceiling on one take, so a forgotten recording cannot run to tab death. */
const MAX_SECS = 120;

export type DictationPhase = 'idle' | 'requesting' | 'recording' | 'transcribing';

export interface DictationState {
  phase: DictationPhase;
  elapsed: number;
  error: string;
  toggle: () => void;
}

/**
 * Tap to record, tap to stop, upload, hand the text back.
 *
 * Owns MediaRecorder and nothing else — the transcript leaves through
 * `onText`, so the hook never knows a textarea exists. Every exit path stops
 * the MediaStream's tracks: a mic indicator still lit after you stopped reads
 * as a bug, and on iOS it is one.
 */
export function useDictation(onText: (text: string) => void): DictationState {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [token] = usePersistedState<string>('dashboard.answerToken', '');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  // Elapsed tick + the 120s cap, both driven off one interval.
  useEffect(() => {
    if (phase !== 'recording') return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      setElapsed(secs);
      if (secs >= MAX_SECS) recorderRef.current?.stop();
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // A drawer that closes mid-take must not leave the mic open.
  useEffect(() => stopTracks, [stopTracks]);

  const upload = useCallback(async (blob: Blob) => {
    setPhase('transcribing');
    const headers: Record<string, string> = { 'Content-Type': blob.type || 'audio/mp4' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/transcribe', { method: 'POST', headers, body: blob });
      if (!res.ok) {
        setError(res.status === 429 ? 'another clip is transcribing' : 'transcription failed');
        return;
      }
      const body = (await res.json()) as TranscribeResponse;
      if (!body.text) setError('nothing heard');
      else onText(body.text);
    } catch {
      setError('transcription failed');
    } finally {
      setPhase('idle');
    }
  }, [token, onText]);

  const start = useCallback(async () => {
    setError('');
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType(t => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stopTracks();
        void upload(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/mp4' }));
      };
      recorderRef.current = rec;
      rec.start();
      setPhase('recording');
    } catch {
      stopTracks();
      setError('microphone unavailable');
      setPhase('idle');
    }
  }, [stopTracks, upload]);

  const toggle = useCallback(() => {
    if (phase === 'recording') recorderRef.current?.stop();
    else if (phase === 'idle') void start();
  }, [phase, start]);

  return { phase, elapsed, error, toggle };
}
