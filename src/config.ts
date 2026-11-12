/** Every environment value the app reads. With none set, the app runs on bundled and mock data. */
const env = process.env;

export const config = {
  /** The wrk. shop API (Medusa), e.g. https://api.wrk.sa, and its publishable key (Medusa admin -> Settings -> Publishable API keys). */
  shopApiUrl: (env.EXPO_PUBLIC_SHOP_API_URL ?? '').replace(/\/+$/, ''),
  shopKey: env.EXPO_PUBLIC_SHOP_KEY ?? '',
  moyasarPublishableKey: env.EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY ?? '',
  supabaseUrl: env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  /** Community ships behind a flag until the legal review is done. Default on for development. */
  communityEnabled: (env.EXPO_PUBLIC_COMMUNITY_ENABLED ?? '1') !== '0',
  supportEmail: env.EXPO_PUBLIC_SUPPORT_EMAIL || 'hello@wrk.sa',
} as const;

const url = (v: string | undefined, fallback: string) => (v || fallback).replace(/\/+$/, '');

/**
 * The three public addresses. Planned: wrk.sa (the community), store.wrk.sa (the store), corporate.wrk.sa (companies).
 * These are the defaults; override them in .env, not in code.
 */
export const links = {
  social: url(env.EXPO_PUBLIC_SOCIAL_URL, 'https://wrk.sa'),
  store: url(env.EXPO_PUBLIC_STORE_URL, 'https://store.wrk.sa'),
  corporate: url(env.EXPO_PUBLIC_CORPORATE_URL, 'https://corporate.wrk.sa'),
} as const;

export const hasShop = () => config.shopApiUrl.length > 0 && config.shopKey.length > 0;
export const hasMoyasar = () => config.moyasarPublishableKey.length > 0;
export const hasSupabase = () => config.supabaseUrl.length > 0 && config.supabaseAnonKey.length > 0;

/** Delivery inside Saudi Arabia is included in the price (the shop has one free-shipping zone). */
export const shipping = { fee: 0, freeFrom: 0 } as const;
