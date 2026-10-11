import { useEffect, useState } from 'react';

export type Route = { name: 'dashboard' } | { name: 'monitor'; id: string };

export function parseHash(hash: string): Route {
  const m = /^#\/monitors\/([^/?#]+)\/?$/.exec(hash);
  if (m?.[1]) {
    try {
      return { name: 'monitor', id: decodeURIComponent(m[1]) };
    } catch {
      return { name: 'dashboard' };
    }
  }
  return { name: 'dashboard' };
}

export function useHashRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parseHash(hash);
}
