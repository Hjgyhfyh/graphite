import { useEffect, useState } from 'react';
import { useUiStore } from '../stores/uiStore';

const QUERY = '(prefers-reduced-motion: reduce)';

function systemPrefersReduced(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY).matches
    : false;
}

export function usePrefersReducedMotion(): boolean {
  const userReduced = useUiStore((s) => s.reducedMotion);
  const [systemReduced, setSystemReduced] = useState(systemPrefersReduced);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setSystemReduced(event.matches);
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);

  return userReduced || systemReduced;
}
