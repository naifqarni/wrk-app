/**
 * Shop client: the wrk. shop on Medusa v2 (api.wrk.sa). Every call carries the shop's publishable key.
 *  - Catalogue: live prices and stock by SKU (/store/wrk/app/catalogue).
 *  - Orders: the cart is built on the server from SKUs (prices are never trusted from the app), and it becomes an
 *    order only after the server has checked the payment with Moyasar (/store/wrk/app/order, /paid).
 *  - Sign-in: a 4-digit code by email (/store/wrk/otp/send, /verify), the same account as store.wrk.sa.
 *  - Signed in: who you are and every order you placed, on the web or in the app (/store/wrk/me, /me/orders).
 *  - Companies: the للشركات request (/store/wrk/lead).
 */
import { config, hasShop } from '@/config';

import { products, skuOf } from './catalogue';
import { personalFields } from './format';
import type { Profile } from './state';
import type { CartLine, OrderStatus } from './types';

export class ShopError extends Error {
  code: 'network' | 'rejected' | 'not-configured' | 'signed-out';
  /** seconds until a new code may be asked for (sign-in only) */
  retryIn?: number;
  constructor(code: ShopError['code'], message?: string, retryIn?: number) {
    super(message ?? code);
    this.name = 'ShopError';
    this.code = code;
    this.retryIn = retryIn;
  }
}

async function call<T>(path: string, init?: RequestInit & { token?: string }, timeoutMs = 15000): Promise<T> {
  if (!hasShop()) throw new ShopError('not-configured');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const { token, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`${config.shopApiUrl}${path}`, {
      ...rest,
      signal: ctl.signal,
      headers: {
        Accept: 'application/json',
        'x-publishable-api-key': config.shopKey,
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
    });
  } catch {
    throw new ShopError('network');
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401 && token) throw new ShopError('signed-out');
    const b = (body && typeof body === 'object' ? body : {}) as { message?: unknown; retry_in?: unknown };
    throw new ShopError('rejected', typeof b.message === 'string' ? b.message : `HTTP ${res.status}`, Number(b.retry_in) || undefined);
  }
  return body as T;
}
const post = (body: unknown, token?: string): RequestInit & { token?: string } => ({ method: 'POST', body: JSON.stringify(body), token });

/* ---------- catalogue ---------- */

/** SKU -> price in SAR (VAT included), and SKU -> in stock. Only SKUs on sale are returned. */
export interface LiveCatalogue { price: Record<string, number>; inStock: Record<string, boolean> }

export async function fetchLiveCatalogue(): Promise<LiveCatalogue> {
  const r = await call<Partial<LiveCatalogue>>('/store/wrk/app/catalogue');
  return { price: r?.price ?? {}, inStock: r?.inStock ?? {} };
}

/* ---------- orders ---------- */

export interface CreatedOrder { id: string; number: string; key: string; total: number; shipping: number; currency: string }

const detailsOf = (who: Profile) => ({
  name: who.fullName, phone: who.mobile, email: who.email,
  city: who.city, district: who.district, street: who.street, short_address: who.extra, save: true,
});

export async function createShopOrder(lines: CartLine[], who: Profile, token?: string): Promise<CreatedOrder> {
  const body = {
    items: lines.map((l) => ({ sku: skuOf(l.id, l.tier), quantity: l.qty, fields: personalFields(products[l.id], l.personal) })),
    customer: { name: who.fullName, mobile: who.mobile, email: who.email },
    address: { city: who.city, district: who.district, street: who.street, short_address: who.extra },
  };
  const r = await call<{ id: string; number: string; key: string; total: number; shipping: number; currency: string }>('/store/wrk/app/order', post(body));
  if (!r || !r.id || !r.key || !(Number(r.total) > 0)) throw new ShopError('rejected', 'bad order response');
  let total = Number(r.total);
  if (token) {
    // Signed in: the cart becomes the customer's (so the order shows on store.wrk.sa too), the address is remembered,
    // and the payment is started again for the customer. Same total; it is read back to be sure.
    try {
      await call('/store/wrk/checkout/details', post({ cart_id: r.id, ...detailsOf(who) }, token));
      const pay = await call<{ amount: number }>('/store/wrk/checkout/pay', post({ cart_id: r.id, provider: 'pp_moyasar_moyasar' }, token));
      if (Number(pay?.amount) > 0) total = Number(pay.amount);
    } catch (e) {
      if (e instanceof ShopError && e.code === 'signed-out') throw e;
      /* the guest order still works; it joins the account the next time they sign in */
    }
  }
  return { id: String(r.id), number: String(r.number ?? r.id), key: r.key, total, shipping: Number(r.shipping) || 0, currency: r.currency || 'SAR' };
}

/** Tells the shop which payment paid the order. The shop checks it with Moyasar before it makes the order. */
export async function confirmShopPayment(cartId: string, key: string, paymentId: string): Promise<{ status: OrderStatus; order_id?: string; order_key?: string }> {
  return call(`/store/wrk/app/order/${encodeURIComponent(cartId)}/paid`, post({ key, payment_id: paymentId }));
}

/** Status of an app order that may still be a cart (before payment is confirmed). */
export async function fetchShopOrder(cartId: string, key: string): Promise<{ status: OrderStatus; tracking_url?: string; eta?: string }> {
  return call(`/store/wrk/app/order/${encodeURIComponent(cartId)}?key=${encodeURIComponent(key)}`);
}

/** An order as the shop shows it to its buyer (store.wrk.sa/o/:id uses the same). */
export interface PublicOrder {
  id: string;
  number: number | string;
  created_at: string;
  stage: 'pending' | 'paid' | 'personalising' | 'shipped' | 'out-for-delivery' | 'delivered' | 'canceled';
  tracking_url: string | null;
  eta: string | null;
  total: number;
  items: { id: string; title: string; sku: string | null; quantity: number; unit_price: number; total: number; fields: Record<string, unknown> }[];
  key?: string;
}

export async function fetchOrderByKey(orderId: string, key: string): Promise<PublicOrder> {
  const r = await call<{ order: PublicOrder }>(`/store/wrk/orders/${encodeURIComponent(orderId)}?k=${encodeURIComponent(key)}`);
  return r.order;
}

/* ---------- sign-in by email code ---------- */

export async function sendCode(email: string): Promise<{ retryIn: number }> {
  const r = await call<{ ok: boolean; retry_in?: number; message?: string }>('/store/wrk/otp/send', post({ email, lang: 'ar' }));
  return { retryIn: Number(r?.retry_in) || 60 };
}

export async function verifyCode(email: string, code: string, name?: string): Promise<{ token: string; email: string; created: boolean }> {
  const r = await call<{ ok: boolean; token?: string; email?: string; created?: boolean }>('/store/wrk/otp/verify', post({ email, code, name }));
  if (!r?.token) throw new ShopError('rejected', 'bad sign-in response');
  return { token: r.token, email: r.email || email, created: !!r.created };
}

export interface Me {
  id: string; name: string; phone: string; email: string;
  addresses: { id: string; city: string; district: string; street: string; short_address: string; line?: string }[];
}
export async function fetchMe(token: string): Promise<Me> {
  const r = await call<{ customer: Me }>('/store/wrk/me', { token });
  return r.customer;
}
export async function fetchMyOrders(token: string): Promise<PublicOrder[]> {
  const r = await call<{ orders: PublicOrder[] }>('/store/wrk/me/orders', { token });
  return r.orders ?? [];
}

/* ---------- للشركات ---------- */

export interface Lead { company: string; phone: string; name?: string; size?: string; note?: string }
export async function sendLead(lead: Lead): Promise<void> {
  await call('/store/wrk/lead', post({ ...lead, ref: 'app' }));
}
