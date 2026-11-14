import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { deriveLed, latestLedEvent, type LedState } from '../lib/led';
import type { LogEntry } from '../lib/types';
import { useEvents } from './events';

export const useStatus = () => useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 5000, retry: 1, staleTime: 2000 });
export const useOnchain = () => useQuery({ queryKey: ['onchain'], queryFn: api.onchain, refetchInterval: 6000, retry: 1, staleTime: 2000 });
export const useCheck = (receiver: string) => useQuery({ queryKey: ['check', receiver], queryFn: () => api.check(receiver), enabled: receiver.length > 0, retry: false, staleTime: 15_000 });
export const useAttempts = () => useQuery({ queryKey: ['attempts'], queryFn: () => api.attempts(20), refetchInterval: 10_000, retry: false });

/** LED state derived from the newest driving event and the heartbeat; a 500 ms clock lets flashes decay. */
export function useLed(): { state: LedState; latest: LogEntry | undefined } {
  const { log, alive } = useEvents();
  const latest = useMemo(() => latestLedEvent(log), [log]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  return { state: deriveLed({ latest, alive, now }), latest };
}
