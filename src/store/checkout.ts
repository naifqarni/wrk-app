/** Order flow: create the order, pay, confirm. Works against the shop when configured, otherwise locally (demo). */
import { Platform } from 'react-native';

import { hasShop, links, shipping } from '@/config';

import { products } from './catalogue';
import { cartCount, cartTotal, useCart, useOrders, type Profile } from './state';
import type { CartLine, Order } from './types';
import { orderFromShop, shopKey, useAccount } from './account';
import { confirmShopPayment, createShopOrder, fetchOrderByKey, fetchShopOrder } from './shop';

export const shippingFor = (subtotal: number) => (subtotal >= shipping.freeFrom || subtotal === 0 ? 0 : shipping.fee);

export interface Started { order: Order; key: string }

export async function startOrder(lines: CartLine[], who: Profile): Promise<Started> {
  const now = new Date().toISOString();
  const base = { status: 'pending-payment' as const, createdAt: now, updatedAt: now, itemCount: cartCount(lines), lines };
  if (hasShop()) {
    const o = await createShopOrder(lines, who, useAccount.getState().token ?? undefined);
    const order: Order = { ...base, id: o.id, number: o.number, total: o.total };
    useOrders.getState().upsert(order, o.key);
    return { order, key: o.key };
  }
  const subtotal = cartTotal(lines);
  const id = 'local-' + Date.now().toString(36);
  const order: Order = { ...base, id, number: String(1000 + (Date.now() % 9000)), total: subtotal + shippingFor(subtotal) };
  useOrders.getState().upsert(order, 'local');
  return { order, key: 'local' };
}

/** Where Moyasar sends the shopper after 3-D Secure. Native intercepts it inside the WebView; web lands on /checkout/return. */
export function callbackUrlFor(orderId: string): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') return `${window.location.origin}/checkout/return?order=${encodeURIComponent(orderId)}`;
  return `${links.store}/wrk-app-return?order=${encodeURIComponent(orderId)}`;
}

export function payDescription(order: Order): string {
  const names = order.lines.map((l) => products[l.id].ar).join('، ');
  return `wrk. #${order.number} · ${names}`.slice(0, 250);
}

/**
 * After Moyasar says paid: tell the shop (it verifies with Moyasar), mark the order, empty the cart.
 * Returns the order's id from now on: the shop's order id once the shop has made the order.
 */
export async function finishPaid(orderId: string, paymentId: string): Promise<string> {
  const { keys, setStatus, rekey } = useOrders.getState();
  const key = keys[orderId];
  let id = orderId;
  if (hasShop() && key && key !== 'local' && !key.startsWith('order:')) {
    const r = await confirmShopPayment(orderId, key, paymentId);
    const status = r.status === 'pending-payment' ? 'paid' : r.status;
    if (r.order_id && r.order_key) {
      rekey(orderId, r.order_id, shopKey(r.order_key), { status });
      id = r.order_id;
      refreshOrder(id).catch(() => {});
    } else setStatus(orderId, status);
  } else {
    setStatus(orderId, 'paid');
  }
  useCart.getState().clear();
  return id;
}

export function markFailed(orderId: string) {
  const o = useOrders.getState().orders.find((x) => x.id === orderId);
  if (o && o.status === 'pending-payment') useOrders.getState().setStatus(orderId, 'cancelled');
}

export async function refreshOrder(orderId: string): Promise<void> {
  const { keys, setStatus, orders } = useOrders.getState();
  const key = keys[orderId];
  const o = orders.find((x) => x.id === orderId);
  if (!hasShop() || !key || key === 'local' || !o || o.status === 'cancelled' || (o.status === 'pending-payment' && !key.startsWith('order:'))) return;
  if (key.startsWith('order:')) {
    const fresh = orderFromShop(await fetchOrderByKey(orderId, key.slice(6)));
    setStatus(orderId, fresh.status, { number: fresh.number, total: fresh.total, trackingUrl: fresh.trackingUrl, etaDate: fresh.etaDate, ...(fresh.lines.length ? { lines: fresh.lines } : {}) });
    return;
  }
  const r = await fetchShopOrder(orderId, key);
  if (r.status !== o.status || r.tracking_url !== o.trackingUrl) setStatus(orderId, r.status, { trackingUrl: r.tracking_url, etaDate: r.eta });
}
