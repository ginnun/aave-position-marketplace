import { useEffect, useState } from 'react';

export type Route = { name: string; param?: string };

function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0];
  const [name = 'market', param] = path.split('/');
  return { name: name || 'market', param };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function go(path: string) {
  window.location.hash = `#/${path.replace(/^\//, '')}`;
}
