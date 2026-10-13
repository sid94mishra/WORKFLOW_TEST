import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'incidents' }
  | { name: 'channels' }
  | { name: 'maintenance' }
  | { name: 'apiKeys' }
  | { name: 'monitor'; id: string };

export function parseHash(hash: string): Route {
  const m = /^#\/monitors\/([^/?#]+)\/?$/.exec(hash);
  if (m?.[1]) {
    try {
      return { name: 'monitor', id: decodeURIComponent(m[1]) };
    } catch {
      return { name: 'dashboard' };
    }
  }
  if (/^#\/incidents\/?$/.test(hash)) return { name: 'incidents' };
  if (/^#\/channels\/?$/.test(hash)) return { name: 'channels' };
  if (/^#\/maintenance\/?$/.test(hash)) return { name: 'maintenance' };
  if (/^#\/settings\/api-keys\/?$/.test(hash)) return { name: 'apiKeys' };
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
