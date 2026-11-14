import { motion, useReducedMotion, type TargetAndTransition, type Transition } from 'framer-motion';
import { LED_LABEL, type LedState } from '../lib/led';

const COLOR: Record<LedState, string> = { idle: 'var(--accent)', signed: 'var(--accent)', refused: 'var(--red)', button: 'var(--amber)', revoked: 'var(--red)' };
const MOTION: Record<LedState, { animate: TargetAndTransition; transition: Transition }> = {
  idle: { animate: { opacity: [0.45, 1, 0.45], scale: [0.96, 1, 0.96] }, transition: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' } },
  signed: { animate: { opacity: [0.2, 1, 0.9], scale: [0.85, 1.12, 1] }, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
  refused: { animate: { opacity: [0.2, 1, 0.9], scale: [0.85, 1.12, 1] }, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
  button: { animate: { opacity: [1, 0.35, 1], scale: [1, 0.9, 1] }, transition: { duration: 0.9, repeat: Infinity, ease: 'easeInOut' } },
  revoked: { animate: { opacity: 1, scale: 1 }, transition: { duration: 0.2 } },
};

/** The one light on the board. SVG group so it sits inside the chip illustration; `flashKey` restarts a flash. */
export function LedDot({ state, cx, cy, r = 9, flashKey = '' }: { state: LedState; cx: number; cy: number; r?: number; flashKey?: string }) {
  const reduced = useReducedMotion();
  const m = MOTION[state]; const color = COLOR[state];
  return (
    <g role="img" aria-label={`LED: ${LED_LABEL[state]}`}>
      <circle cx={cx} cy={cy} r={r + 1.5} fill="rgba(0,0,0,0.5)" />
      <motion.g key={`${state}:${flashKey}`} style={{ transformOrigin: `${cx}px ${cy}px` }} initial={false} animate={reduced ? { opacity: 1, scale: 1 } : m.animate} transition={reduced ? { duration: 0 } : m.transition}>
        <circle cx={cx} cy={cy} r={r * 3.2} fill={color} opacity={0.18} />
        <circle cx={cx} cy={cy} r={r * 1.9} fill={color} opacity={0.28} />
        <circle cx={cx} cy={cy} r={r} fill={color} />
        <circle cx={cx - r * 0.3} cy={cy - r * 0.35} r={r * 0.32} fill="rgba(255,255,255,0.55)" />
      </motion.g>
    </g>
  );
}
