import { useEffect, useRef } from 'react';
import { Check, X, CircleNotch } from '@phosphor-icons/react';
import type { Dictation } from '../../hooks/useDictation';

const iconBtn = (bg: string, color: string) => ({
  flexShrink: 0, width: 40, height: 40, borderRadius: 12, border: 'none',
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
  const { state, error } = dictation;

  if (state === 'error') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--color-status-red)' }}>{error}</span>
        <button onClick={() => void dictation.start()} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 13 }}>Retry</button>
        <button onClick={dictation.reset} style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 13 }}>Dismiss</button>
      </div>
    );
  }

  if (state === 'transcribing') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--color-text-secondary)', fontSize: 13 }}>
        <CircleNotch size={18} className="dispatch-spin" /> Transcribing…
      </div>
    );
  }

  // recording
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <button aria-label="Cancel dictation" onClick={dictation.cancel} style={iconBtn('var(--color-hover)', 'var(--color-text-secondary)')}>
        <X size={18} weight="bold" />
      </button>
      <Waveform dictation={dictation} />
      <button aria-label="Confirm dictation" onClick={() => void dictation.confirm()} style={iconBtn('var(--color-accent)', '#06140B')}>
        <Check size={18} weight="bold" />
      </button>
    </div>
  );
}
