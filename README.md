# wrk. app

iOS and Android app for wrk.: the work community (المجتمع, members only, opens first), company spaces (الشركات) and the account (حسابي). The store is a quiet row inside the account page.

Version 2 runs on the wrk. shop as it is now: Medusa v2 at api.wrk.sa, the same shop as store.wrk.sa. Sign-in is a 4-digit code
sent by email (the shop's own Resend sender, noreply@wrk.sa), the same account as on the web, so web orders show in the app.
No SMS, no WhatsApp, no WooCommerce.
Arabic, right-to-left, light mode. Expo SDK 58, React Native 0.88, TypeScript, expo-router.

## Run it

```bash
npm install
cp .env.example .env        # optional: with an empty .env the app runs on bundled data and demo payment
npm run web                 # in the browser (quickest look)
npm run ios                 # iOS simulator or device, needs a Mac with Xcode
npm run android             # Android emulator or device, needs Android Studio
```

The app uses native modules (WebView for 3D and 3-D Secure, haptics, hinge sensor), so on a phone it needs a
development build, not Expo Go. Without a Mac: `npx eas-cli@latest build --profile development --platform ios`
(needs an Apple Developer account) or `--platform android`.

Checks: `npm run typecheck`, `npm test`, `npm run build:web`.

## What talks to what

| Part | Where | Needs |
|---|---|---|
| Catalogue | bundled in `src/store/catalogue.ts` (words, photos, 3D); live prices and stock by SKU from `/store/wrk/app/catalogue` | `EXPO_PUBLIC_SHOP_API_URL`, `EXPO_PUBLIC_SHOP_KEY` (Medusa publishable key) |
| Orders | Medusa `/store/wrk/app/order` builds the cart from SKUs at the shop's prices; `/paid` checks the Moyasar payment on the server and makes the order | `MOYASAR_SECRET_KEY` on the Medusa server (already there for the web) |
| Account | email code: `/store/wrk/otp/send` and `/verify` give a customer token (kept in the keychain); `/store/wrk/me` fills the address, `/me/orders` lists web and app orders; signed-in checkouts go through `/store/wrk/checkout/details` and `/pay` so the order joins the account | nothing extra |
| للشركات | native page; the request goes to `/store/wrk/lead` (admin, "طلبات الشركات") | nothing extra |
| Payment | Moyasar REST API with the publishable key: card (mada, Visa, Mastercard) with 3-D Secure, STC Pay | `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY` |
| 3D | `viewer-src/` (three.js + the wrk. product models) built into `src/store/viewer/viewerHtml.ts` | `npm run build:viewer` after changing models |
| Community | `src/community/` against Supabase (`backend/`), or an in-memory mock when no keys are set | `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` |

With no payment key the checkout is in demo mode: any valid card number (for example 4111 1111 1111 1111) "pays",
a number ending 0002 is declined, and nothing is charged.

## Going live

The app is complete without these; each one switches a part from its stand-in to the real service.

1. Shop: `EXPO_PUBLIC_SHOP_API_URL=https://api.wrk.sa` and `EXPO_PUBLIC_SHOP_KEY` = the store's publishable key
   (Medusa admin, Settings, Publishable API keys; it is public, the website uses the same one). The app's origin
   does not need CORS on native; for the web build add its address to Medusa's `STORE_CORS`.
2. Payment: put the Moyasar publishable key in `EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY` (the same pk_ the website uses).
   Until then checkout says it is in demo mode, and a live shop refuses demo payments.
3. Community: create the Supabase project from `backend/` (its README has the steps), set
   `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and give the backend `SHOP_URL=https://api.wrk.sa`
   and `SHOP_BRIDGE_SECRET` (the same value as `WRK_BRIDGE_SECRET` on the Medusa server). Until then the community
   runs on sample data inside the app.
4. First members: `select * from private.mint_invites(null, 10, 'launch');` in Supabase gives the first invitation
   codes. After that each member has 3 invitations, and anyone who bought from the shop joins with the order's email.

5. Addresses: `EXPO_PUBLIC_SOCIAL_URL`, `EXPO_PUBLIC_STORE_URL`, `EXPO_PUBLIC_CORPORATE_URL` for wrk.sa, store.wrk.sa and
   corporate.wrk.sa once the domains are live.
6. Company icons: after the backend is up, fetch them from the moderator console (backend README, step 10).

The community is members only: by invitation, or with the email of a shop order. Checkout asks for the email for
that reason.

## Layout of the code

```
src/app/            routes (expo-router): (tabs)/index community, (tabs)/companies, (tabs)/account, account/sign-in, store, corporate, intro, product/[id], cart, checkout, order/[id]
src/store/          catalogue, cart and personalisation state, shop client (shop.ts), account (account.ts), Moyasar client, 3D viewer
src/community/      community screens, state and API client
src/intro/          first-launch intro; the words are in src/intro/strings.ts
src/ui, src/theme, src/layout   design system, tokens, foldable and large-screen layout
viewer-src/         sources of the 3D viewer page
tests/              unit tests for the pure logic
```

## Builds on GitHub

`.github/workflows/`:
- `checks.yml` on every push: typecheck, tests, web export.
- `android.yml` (run by hand, or push a tag `v*`): an installable release APK as the run's artifact. It is signed with
  the debug key, which is fine to install and test; the Play Store needs an upload key later.
- `ios-unsigned.yml` (run by hand): an unsigned ipa to sideload (below).

The keys come from the repository's Actions secrets, never from the code: `EXPO_PUBLIC_SHOP_KEY` (store publishable key),
`EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY`, and optionally `EXPO_PUBLIC_SHOP_API_URL` (defaults to https://api.wrk.sa),
`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`.

## iOS build without a Mac

`.github/workflows/ios-unsigned.yml` builds an unsigned `wrk-unsigned.ipa` on a GitHub macOS runner (push this folder
to a GitHub repository, then run the "iOS unsigned ipa" workflow and download the artifact). Sign and install it with
Sideloadly or AltStore. That build sets `WRK_SIDELOAD=1`, which leaves out the widget and Live Activity extension
because a free Apple ID cannot sign its entitlements. For TestFlight use `npx eas-cli@latest build --platform ios`.

