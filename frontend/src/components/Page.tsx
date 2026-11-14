import type { ReactNode } from 'react';
import { Footer } from './Footer';
import { Nav } from './Nav';
import { Takeover } from './Takeover';

export function Page({ children, takeover = false }: { children: ReactNode; takeover?: boolean }) {
  return (
    <div className="min-h-dvh flex flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] btn-quiet bg-surface">Skip to content</a>
      <Nav />
      <main id="main" className="flex-1">{children}</main>
      <Footer />
      {takeover && <Takeover />}
    </div>
  );
}
