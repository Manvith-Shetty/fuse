import { motion, useReducedMotion } from 'framer-motion';
import type { Verdict } from '../lib/types';

const COLOR: Record<Verdict, string> = { allow: 'text-accent-deep', warn: 'text-amber', block: 'text-red' };

/** The verdict is one word. It fades in; nothing else moves. */
export function VerdictWord({ verdict, size = 'lg', wordKey = '' }: { verdict: Verdict; size?: 'lg' | 'md'; wordKey?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      key={`${verdict}:${wordKey}`}
      role="status"
      aria-label={`verdict: ${verdict}`}
      className={`font-display font-semibold tracking-[-0.04em] leading-none ${COLOR[verdict]} ${size === 'lg' ? 'text-[72px] sm:text-[112px]' : 'text-[40px]'}`}
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
    >
      {verdict}
    </motion.div>
  );
}
