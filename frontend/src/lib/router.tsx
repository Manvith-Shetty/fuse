// A very small history router: enough for five pages, no dependency.
import { createContext, useCallback, useContext, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());
const subscribe = (l: () => void) => {
  listeners.add(l); window.addEventListener('popstate', l);
  return () => { listeners.delete(l); window.removeEventListener('popstate', l); };
};
const getPath = () => window.location.pathname.replace(/\/+$/, '') || '/';

export function navigate(to: string) {
  if (getPath() === to) return;
  window.history.pushState(null, '', to); notify(); window.scrollTo({ top: 0 });
}
export function usePath(): string { return useSyncExternalStore(subscribe, getPath, () => '/'); }

const RouterCtx = createContext<string>('/');
export function Router({ children }: { children: ReactNode }) { return <RouterCtx.Provider value={usePath()}>{children}</RouterCtx.Provider>; }
export const useRoute = () => useContext(RouterCtx);

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const path = useRoute();
  const handle = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); navigate(to);
  }, [to, onClick]);
  return <a href={to} onClick={handle} aria-current={path === to ? 'page' : undefined} {...rest} />;
}
