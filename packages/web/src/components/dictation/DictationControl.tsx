import { useEffect, useRef, useState } from 'react';
import { RecordingsSheet } from './RecordingsSheet';
import { Check, X } from '@phosphor-icons/react';
import type { Dictation } from '../../hooks/useDictation';
import { Spinner } from '../common/Spinner';

const iconBtn = (bg: string, color: string) => ({
  flexShrink: 0, width: 40, height: 40, borderRadius: 'var(--radius-lg)', border: 'none',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: bg, color,
} as const);

function Waveform({ dictation }: { dictation: Dictation }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current; const analyser = dictation.getAnalyser();
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width, h = canvas.height;
          ctx.clearRect(0, 0, w, h);
          const bins = analyser ? analyser.frequencyBinCount : 32;
          const data = new Uint8Array(bins);
          analyser?.getByteFrequencyData(data);
          const bars = 28; const bw = w / bars;
          const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent') || '#3ECF6A';
          ctx.fillStyle = accent.trim() || '#3ECF6A';
          for (let i = 0; i < bars; i++) {
            const v = analyser ? data[Math.floor((i / bars) * bins)] / 255 : 0.15 + 0.1 * Math.abs(Math.sin(i));
            const bh = Math.max(3, v * h);
            ctx.fillRect(i * bw + 1, (h - bh) / 2, bw - 2, bh);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [dictation]);
  return <canvas ref={canvasRef} width={240} height={40} style={{ flex: 1, minWidth: 0, height: 40 }} />;
}

export function DictationControl({ dictation }: { dictation: Dictation }) {
  const { state, error, progress } = dictation;
  const [sheet, setSheet] = useState(false);
  const link = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, padding: 0 } as const;
  const recordings = <RecordingsSheet open={sheet} onClose={() => setSheet(false)} onInsert={(t) => { dictation.insert(t); dictation.reset(); }} />;

  if (state === 'error') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--color-status-red)' }}>{error}</span>
        <button type="button" onClick={() => void dictation.retry()} style={{ ...link, color: 'var(--color-accent)' }}>Retry</button>
        {dictation.recordingId && <button type="button" onClick={() => setSheet(true)} style={{ ...link, color: 'var(--color-text-secondary)' }}>Recordings</button>}
        <button type="button" onClick={dictation.reset} style={{ ...link, color: 'var(--color-text-secondary)' }}>Dismiss</button>
        {recordings}
      </div>
    );
  }

  // Say what is happening (2026-11-07): the upload with its percentage, then the seconds the provider takes.
  if (state === 'uploading' || state === 'transcribing') {
    const pct = Math.round((progress?.pct ?? 0) * 100);
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, color: 'var(--color-text-secondary)', fontSize: 13 }}>
        <Spinner size={16} />
        <span role="status" style={{ flexShrink: 0 }}>{state === 'uploading' ? `Uploading ${pct}%` : `Transcribing… ${progress?.elapsedS ?? 0}s`}</span>
        {state === 'uploading' && (
          <span role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Upload" style={{ flex: 1, minWidth: 30, height: 4, borderRadius: 'var(--radius-xs)', background: 'var(--color-hover)', overflow: 'hidden' }}>
            <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--color-accent)', transition: 'width .2s ease' }} />
          </span>
        )}
      </div>
    );
  }

  // recording
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <button type="button" aria-label="Cancel dictation" onClick={dictation.cancel} style={iconBtn('var(--color-hover)', 'var(--color-text-secondary)')}>
        <X size={18} weight="bold" />
      </button>
      <Waveform dictation={dictation} />
      <button type="button" aria-label="Confirm dictation" onClick={() => void dictation.confirm()} style={iconBtn('var(--color-accent)', '#06140B')}>
        <Check size={18} weight="bold" />
      </button>
    </div>
  );
}
