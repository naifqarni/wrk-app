/** Orders as the shop (Medusa) shows them to their buyer, turned into the app's own Order. Pure: no storage, no network. */
import type { PublicOrder } from './shop';
import type { CartLine, Order, OrderStatus, Personal, ProductId, TierId } from './types';

/** SKU on the shop -> the piece in the app. */
const SKU: Record<string, { id: ProductId; tier: TierId | null }> = {
  'WRK-KIT-ESS': { id: 'kit', tier: null }, 'WRK-KIT-SIG': { id: 'kit', tier: null }, 'WRK-KIT-PRE': { id: 'kit', tier: null },
  'WRK-BADGE': { id: 'badge', tier: null }, 'WRK-PEN': { id: 'pen', tier: null }, 'WRK-NOTEBOOK': { id: 'notebook', tier: null },
  'WRK-CARD': { id: 'card', tier: null }, 'WRK-CARDCASE': { id: 'cardcase', tier: null }, 'WRK-TRAY': { id: 'tray', tier: null },
  'WRK-NAMEPLATE': { id: 'nameplate', tier: null },
};

export const statusOfStage = (stage: PublicOrder['stage']): OrderStatus =>
  stage === 'canceled' ? 'cancelled' : stage === 'pending' ? 'pending-payment' : stage;

/** An order from the shop as the app keeps it. Lines the app does not know (a retired SKU) are left out. */
export function orderFromShop(o: PublicOrder): Order {
  const lines: CartLine[] = [];
  for (const it of o.items) {
    const hit = it.sku ? SKU[it.sku] : undefined;
    if (!hit) continue;
    const f = it.fields || {};
    const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '');
    const personal: Personal = { name: s('الاسم'), nameEn: s('Name'), date: s('أول يوم'), msg: s('الرسالة'), from: s('من') };
    lines.push({ key: it.id, id: hit.id, tier: hit.tier, price: Number(it.unit_price) || 0, qty: Number(it.quantity) || 1, personal });
  }
  return {
    id: o.id,
    number: String(o.number),
    status: statusOfStage(o.stage),
    createdAt: o.created_at,
    updatedAt: o.created_at,
    etaDate: o.eta ?? undefined,
    trackingUrl: o.tracking_url ?? undefined,
    itemCount: lines.reduce((n, l) => n + l.qty, 0) || o.items.reduce((n, i) => n + (Number(i.quantity) || 0), 0),
    total: Number(o.total) || 0,
    lines,
  };
}
