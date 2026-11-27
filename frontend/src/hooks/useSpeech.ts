import { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudio, fetchSpeechHealth } from '../lib/api';

export type SpeechState = 'idle' | 'recording' | 'transcribing';

interface UseSpeechOptions {
  /**
   * Called when recording stops on its own (silence or time limit). Manual
   * stops use the value returned by ``stopRecording`` instead.
   */
  onTranscribed?: (text: string) => void;
  /** Silence, in ms, that ends an utterance once speech has started. */
  silenceMs?: number;
  /** Hard cap so a noisy room can never record forever. */
  maxMs?: number;
  /** RMS below this counts as silence (mic levels vary widely). */
  threshold?: number;
}

export function useSpeech(options: UseSpeechOptions = {}) {
  const {
    onTranscribed,
    silenceMs = 1000,
    maxMs = 60_000,
    threshold = 0.012,
  } = options;

  const [state, setState] = useState<SpeechState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const stoppingRef = useRef(false);
  const heardSpeechRef = useRef(false);
  const lastVoiceAtRef = useRef(0);
  const startedAtRef = useRef(0);
  const pendingRef = useRef<((text: string) => void) | null>(null);
  const pendingRejectRef = useRef<((error: unknown) => void) | null>(null);

  useEffect(() => {
    fetchSpeechHealth()
      .then((health) => setAvailable(health.available))
      .catch(() => setAvailable(false));
  }, []);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  /** Runs once per recording, whether the stop was manual, silent or capped. */
  const handleStop = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    const chunks = chunksRef.current;
    const mimeType = recorder?.mimeType || 'audio/webm';
    const resolve = pendingRef.current;
    const reject = pendingRejectRef.current;

    pendingRef.current = null;
    pendingRejectRef.current = null;
    stoppingRef.current = false;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    teardown();

    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
      setState('idle');
      reject?.(new Error('No audio was recorded'));
      return;
    }

    setState('transcribing');
    void transcribeAudio(blob)
      .then((result) => {
        setState('idle');
        const text = result.text?.trim() ?? '';
        if (resolve) resolve(text);
        else if (text) onTranscribed?.(text);
      })
      .catch((err: unknown) => {
        setState('idle');
        const message = err instanceof Error ? err.message : 'Transcription failed';
        setError(message);
        reject?.(err);
      });
  }, [onTranscribed, teardown]);

  const requestStop = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || stoppingRef.current) return;
    stoppingRef.current = true;
    if (recorder.state === 'inactive') {
      // The recorder already stopped itself (device removed, error). Finish up
      // rather than leaving the UI stuck on "recording" forever.
      handleStop();
      return;
    }
    try {
      recorder.stop();
    } catch {
      handleStop();
    }
  }, [handleStop]);

  const startRecording = useCallback(async (): Promise<void> => {
    setError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      stoppingRef.current = false;
      heardSpeechRef.current = false;
      lastVoiceAtRef.current = 0;
      startedAtRef.current = performance.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = handleStop;
      recorder.onerror = () => {
        setError('Recording stopped unexpectedly');
        requestStop();
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setState('recording');

      // Silence detection: end the utterance shortly after the user stops
      // talking, so the mic is not a manual push-to-talk toggle.
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          ctx.createMediaStreamSource(stream).connect(analyser);
          const buffer = new Float32Array(analyser.fftSize);
          audioCtxRef.current = ctx;

          const tick = () => {
            if (!mediaRecorderRef.current) return;
            analyser.getFloatTimeDomainData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
            const rms = Math.sqrt(sum / buffer.length);
            const now = performance.now();

            if (rms > threshold) {
              heardSpeechRef.current = true;
              lastVoiceAtRef.current = now;
            } else if (
              heardSpeechRef.current &&
              now - lastVoiceAtRef.current > silenceMs
            ) {
              requestStop();
              return;
            }

            const tooLong = now - startedAtRef.current > maxMs;
            const noSpeechYet =
              !heardSpeechRef.current && now - startedAtRef.current > 10_000;
            if (tooLong || noSpeechYet) {
              requestStop();
              return;
            }
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        }
      } catch {
        // No analyser (older browser): recording still works, but only a
        // click or the max duration will end it.
      }
    } catch {
      setError('Microphone access denied');
      setState('idle');
    }
  }, [handleStop, maxMs, requestStop, silenceMs, threshold]);

  const stopRecording = useCallback(async (): Promise<string> => {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        reject(new Error('Not recording'));
        return;
      }
      pendingRef.current = resolve;
      pendingRejectRef.current = reject;
      requestStop();
    });
  }, [requestStop]);

  // Never leave a microphone live after unmount.
  useEffect(() => teardown, [teardown]);

  return {
    state,
    error,
    available,
    startRecording,
    stopRecording,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}
