import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEvents } from '../hooks/events';
import { Chip } from './Chip';

/** When the heartbeat dies the page goes quiet: big words, a red LED, one line. Revocation is a cable. */
export function Takeover() {
  const { alive, link, heartbeat } = useEvents();
  const reduced = useReducedMotion();
  const show = alive === false;
  return (
    <AnimatePresence>
      {show && (
        <motion.div role="alert" className="fixed inset-0 z-50 bg-paper flex items-center justify-center px-6"
          initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <div className="w-full max-w-[720px] text-center">
            <div className="mx-auto w-[260px] sm:w-[320px]"><Chip state="revoked" /></div>
            <h1 className="mt-8 text-[44px] sm:text-[72px] text-ink">Agent revoked</h1>
            <p className="lead mt-4">{link === 'offline' && !heartbeat ? 'bridge offline: nothing can be signed' : 'unplugged: nothing can be signed'}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
