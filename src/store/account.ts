/**
 * The shop account: signed in with a code sent to the email (the same account as store.wrk.sa).
 * The token is kept in the keychain / keystore (expo-secure-store); on web, in local storage.
 * Signing in fills the delivery details and brings every order of that email into the app, web orders too.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { ShopError, fetchMe, fetchMyOrders, verifyCode, type Me, type PublicOrder } from './shop';
import { useOrders, useProfile } from './state';
import { orderFromShop } from './shopOrder';

const secure: StateStorage = Platform.OS === 'web'
  ? AsyncStorage
  : {
      getItem: (k) => SecureStore.getItemAsync(k),
      setItem: (k, v) => SecureStore.setItemAsync(k, v),
      removeItem: (k) => SecureStore.deleteItemAsync(k),
    };

interface AccountState {
  token: string | null;
  email: string;
  name: string;
  set: (patch: Partial<Pick<AccountState, 'token' | 'email' | 'name'>>) => void;
  signOut: () => void;
}
export const useAccount = create<AccountState>()(
  persist(
    (set) => ({
      token: null, email: '', name: '',
      set: (patch) => set(patch),
      signOut: () => set({ token: null, email: '', name: '' }),
    }),
    { name: 'wrk-account-v1', storage: createJSONStorage(() => secure) },
  ),
);
export const signedIn = () => !!useAccount.getState().token;

export { orderFromShop };

/** Order keys: "app" orders are still read by cart id; shop orders by the order id and its signed key. */
export const shopKey = (k: string) => `order:${k}`;

/** Pull this account's orders (web and app) into the list on this device. */
export async function syncMyOrders(): Promise<void> {
  const { token, signOut } = useAccount.getState();
  if (!token) return;
  let list: PublicOrder[];
  try {
    list = await fetchMyOrders(token);
  } catch (e) {
    if (e instanceof ShopError && e.code === 'signed-out') signOut();
    throw e;
  }
  const { upsert, orders } = useOrders.getState();
  for (const o of list) {
    const mine = orderFromShop(o);
    const had = orders.find((x) => x.id === mine.id);
    upsert(!mine.lines.length && had ? { ...mine, lines: had.lines } : mine, o.key ? shopKey(o.key) : undefined);
  }
}

/** Fill the delivery form with what the shop remembers, without overwriting what was typed on this device. */
export function fillProfile(me: Me) {
  const p = useProfile.getState();
  const a = me.addresses[0];
  p.set({
    fullName: p.fullName || me.name || '',
    mobile: p.mobile || me.phone || '',
    email: me.email || p.email,
    ...(a && !p.city ? { city: a.city || '', district: a.district || '', street: a.street || '', extra: a.short_address || '' } : {}),
  });
}

/** The last step of sign-in: keep the token, fill the details, bring the orders. */
export async function finishSignIn(email: string, code: string, name?: string): Promise<{ created: boolean }> {
  const r = await verifyCode(email, code, name);
  useAccount.getState().set({ token: r.token, email: r.email });
  try {
    const me = await fetchMe(r.token);
    useAccount.getState().set({ name: me.name || '' });
    fillProfile(me);
  } catch { /* the details can come later */ }
  syncMyOrders().catch(() => {});
  return { created: r.created };
}
