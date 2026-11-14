import { useEffect, useRef, type ReactNode } from 'react';

/** Scroll reveal with restraint: 10 px rise and a fade, once, and nothing at all under prefers-reduced-motion. */
export function Reveal({ children, className = '', as: Tag = 'section', id }: { children: ReactNode; className?: string; as?: 'section' | 'div'; id?: string }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.classList.add('is-in'); return; }
    const io = new IntersectionObserver(entries => { for (const en of entries) if (en.isIntersecting) { el.classList.add('is-in'); io.disconnect(); } }, { rootMargin: '0px 0px -5% 0px', threshold: 0 });
    io.observe(el); return () => io.disconnect();
  }, []);
  return <Tag ref={ref as never} id={id} className={`reveal ${className}`}>{children}</Tag>;
}
