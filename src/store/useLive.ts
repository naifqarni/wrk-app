import { useQuery } from '@tanstack/react-query';

import { hasShop } from '@/config';

import { fetchLiveCatalogue, type LiveCatalogue } from './shop';

/** Live prices and stock from the shop. Undefined until (and unless) the shop answers; the bundled catalogue is used meanwhile. */
export function useLive(): LiveCatalogue | undefined {
  const q = useQuery({ queryKey: ['shop', 'catalogue'], queryFn: fetchLiveCatalogue, enabled: hasShop(), staleTime: 5 * 60_000, retry: 1 });
  return q.data;
}
