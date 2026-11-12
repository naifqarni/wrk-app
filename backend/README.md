# wrk. community backend

Supabase project for the المجتمع tab. The community is members-only: a new person gets in with an invite code or because they bought from the store. Then: pseudonymous members, channels, posts, comments, likes, notifications, report, block, a moderation queue, an Arabic and English text filter, optional AI review, and the data-protection functions (export, erase, retention).

```
supabase/migrations/   the whole database: tables, access rules, every function the app calls
supabase/functions/    5 edge functions: auth-request-code, auth-verify-code, auth-work-email, moderate, push
supabase/seed.sql      optional demo posts
moderator-console/     one HTML page for whoever reviews reports each day
tests/                 25 end-to-end tests that run on a plain local PostgreSQL
DATA-HANDLING.md       what is stored, for how long, and what PDPL still needs from you
```

The app side is `wrk-app/src/community/api/supabase.ts` (+ `index.ts`). The app never touches a table: every table has row level security on with no policies, and all access goes through checked functions.

## Set it up (about ten minutes)

You need Node 20+ and a terminal (PowerShell is fine). Run commands from this `backend` folder.

**1. Create the project.** At supabase.com, New project. Pick the region closest to Saudi Arabia that is offered (see DATA-HANDLING.md about data leaving the Kingdom). Save the database password. From Project Settings, API, copy the **Project URL**, the **anon public** key and the **project ref** (the `xxxx` in `https://xxxx.supabase.co`).

**2. Push the database.**
```
npx supabase login
npx supabase link --project-ref YOUR_REF
npx supabase db push
```

**3. Set the secrets.** Generate two random values:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
The first is `EMAIL_PEPPER`, the second `CRON_SECRET`. **Save EMAIL_PEPPER in a password manager now.** If it is ever lost or changed, existing members can no longer be matched to their work email.
```
npx supabase secrets set EMAIL_PEPPER=first_value CRON_SECRET=second_value
```

**4. Sending the codes.** Create a resend.com account, add and verify the domain `wrk.sa` (the shop already sends from noreply@wrk.sa through Resend, so the domain may be verified already), create an API key, then:
```
npx supabase secrets set RESEND_API_KEY=re_xxx "MAIL_FROM=wrk. <noreply@wrk.sa>"
```
To try the app before the domain is verified: `npx supabase secrets set DEV_ECHO_CODE=true`. The code then appears in the app's console instead of an inbox. Remove it before launch: `npx supabase secrets unset DEV_ECHO_CODE`.

**5. Connect the shop (the "I bought from wrk." door).** The sign-in function asks the shop whether an order exists for an email. The shop is Medusa at api.wrk.sa; use the same value as its `WRK_BRIDGE_SECRET` (24+ characters):
```
npx supabase secrets set SHOP_URL=https://api.wrk.sa SHOP_BRIDGE_SECRET=the_bridge_secret   # same value as WRK_BRIDGE_SECRET on the Medusa server
```
The shop answers `POST /wrk/buyer` (header `X-Wrk-Bridge-Secret`, body `{"email":"..."}`) with `{"buyer":true}` or `{"buyer":false}`. If the shop cannot be reached, nobody is let in on that door until it is back; invitations keep working.

**6. Deploy the functions.**
```
npx supabase functions deploy
```

**7. Create the first invitations.** Nobody is a member yet, so the first codes come from you. In the SQL editor:
```sql
select * from private.mint_invites(null, 10, 'launch');
```
Each code (like `WRK-7Q4K-2M9X`) lets one person in, once. From then on every member has 3 codes of their own to give, and a moderator can mint more from the console.

**8. Point the app at it.** In `wrk-app/.env`:
```
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_REF.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=the anon public key
```
Restart the app. Without these two lines the community tab keeps running on its built-in mock.

**9. Make yourself a moderator.** Join in the app with one of the codes from step 7 and your work email, note your handle, then in the Supabase SQL editor:
```sql
update public.members set role = 'moderator' where handle = 'قلم هادئ 42';
```
Open `moderator-console/index.html` in a browser, paste the Project URL and anon key once, sign in with the same email. That page is the daily review queue, and it can mint five new invitations at a time. Apple and Google expect reports to be handled within 24 hours; the queue shows each item's deadline and what is overdue.

**10. Company icons.** The directory ships with 278 large Saudi employers. Their icons are not in the database yet: the `company-icons` function copies each company's own public site icon into a storage bucket of this project (`company-icons`, created on first run), so the app never loads anything from a company's server. Open the moderator console, "الشركات وسؤال الأسبوع", and press "جلب أيقونات الشركات" until it says there is nothing left (30 companies a press). Or let it run by itself:
```sql
select cron.schedule('wrk-icons', '17 3 * * *', $$
  select net.http_post(
    url := 'https://YOUR_REF.supabase.co/functions/v1/company-icons',
    headers := '{"content-type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    body := '{"limit":30}'::jsonb)
$$);
```
A company with no usable icon (only an SVG or .ico, or a site that refuses us) simply shows the wrk. monogram. Icons are stored exactly as published. **If a company asks for its icon to be removed**: console, type its domain, "إخفاء الأيقونة". It disappears from the app at once and our copy is deleted. See "Company names and icons" in DATA-HANDLING.md.

### Optional: AI review (Arabic and English)

Every post and comment always passes the word filter in the database. AI review adds a second reader that catches what a word list cannot: naming a person with an accusation, leaks, threats in dialect.
```
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxx
npx supabase functions deploy moderate
```
```sql
update public.app_settings set value = 'true' where key = 'ai_moderation';
```
From then on a new post is visible only to its author until the AI answers (a few seconds): allowed posts are published, doubtful ones go to the moderator queue, clear violations are refused. If the AI cannot be reached, the post waits and is handed to a moderator after 10 minutes. It is never published unreviewed.

The model is `claude-opus-5-5` by default, with Anthropic's refusal fallback switched on so abusive text still gets a verdict. At launch volumes the cost is small; if it grows, `npx supabase secrets set MODERATION_MODEL=claude-haiku-5-5` is far cheaper and is your call.

Schedule the retry sweep (SQL editor, replace both placeholders; needs the `pg_net` extension, on by default):
```sql
select cron.schedule('wrk-moderate-sweep', '* * * * *', $$
  select net.http_post(
    url := 'https://YOUR_REF.supabase.co/functions/v1/moderate',
    headers := '{"content-type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    body := '{"sweep":true}'::jsonb)
$$);
```

### Optional: push notifications
The database already records who should be notified. To deliver them to phones, schedule the push function the same way:
```sql
select cron.schedule('wrk-push', '* * * * *', $$
  select net.http_post(
    url := 'https://YOUR_REF.supabase.co/functions/v1/push',
    headers := '{"content-type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    body := '{}'::jsonb)
$$);
```
The app must call `registerPushToken(expoPushToken, platform)` after the user allows notifications. Push text is generic ("تعليق جديد على منشورك"); nothing a member wrote is sent to Apple or Google.

### Optional: demo posts
Paste `supabase/seed.sql` into the SQL editor. Six demo members, eight posts. Remove with `delete from auth.users where email like '%@demo.wrk.invalid';`

## Who gets in

| Door | What the person gives | Checks |
|---|---|---|
| Invitation | a code + their work email | the code exists and is unused; personal mail is refused |
| Bought from wrk. | the email they ordered with | the shop confirms an order; personal mail is fine, throw-away mail is not |
| Returning member | their email | an account exists for it |

An invitation is used up when the code sent to the email is confirmed, not when it is typed, and failed attempts never burn it. If two people try the same code, the first to confirm wins and the other is told it is used. An existing member who types an invitation is simply signed in and the code stays good. Deleting an account voids that member's unused codes; a ban does too.

A buyer with a personal email has no company: they read and post everywhere except the company channel, with no company beside their handle. They can add a work email later (`auth-work-email`), which attaches the employer and opens the company channel. The same function lets any member move to a new employer; either address then signs them in. A buyer whose order email is a work address gets the company at once.

Nothing is readable signed out. `check_invite` is the only content-free call a signed-out app can make.

## How sign-in keeps people anonymous

1. The app sends the email to `auth-request-code`. The function lower-cases it, drops any `+tag`, and computes `HMAC-SHA256(EMAIL_PEPPER, email)`. Only that hash and the domain go to the database. On the invitation door personal mail is refused: gmail, hotmail, outlook, yahoo, icloud, proton and over a hundred more providers in every country version. Throw-away services are refused on every door.
2. A 6-digit code goes out by email. It lasts 10 minutes, works once, and dies after 5 wrong tries. Limits: one code a minute, 3 per 15 minutes, 10 a day per address. Every request, whatever its outcome, also counts toward 15 a day per address and 30 an hour per network address, so the form cannot be used to test which addresses are members or customers.
3. `auth-verify-code` checks the code. On first sign-in it creates a Supabase auth user whose "email" is a random placeholder (`<uuid>@members.wrk.invalid`), creates the member with a random handle such as "قلم هادئ 42", attaches the company when the domain is a work domain, marks the invitation used, and gives the new member 3 invitations. It returns a one-time token; the app exchanges it for a normal Supabase session.

The address is not written to any table or log. One honest limit: whoever holds both the database and `EMAIL_PEPPER` can test whether one specific address has an account. That is unavoidable if the same email must lead back to the same account. Nobody can list the addresses.

A member's employer is confirmed again every 12 months (`verification_months` in `app_settings`) by signing in with the work address; an expired member can read but not post or open the company channel. Members without an employer are not affected.

## What the app calls

All through `supabase.rpc(name, args)`; errors carry the contract's code as the message.

| Area | Functions |
|---|---|
| Identity | `me`, `accept_rules`, `update_me`, `export_my_data`, `delete_my_account` |
| Invitations | `check_invite` (works signed out), `list_my_invites` |
| Reading | `list_channels`, `list_posts`, `get_post`, `list_comments` |
| Writing | `create_post`, `delete_post`, `create_comment`, `delete_comment`, `set_like`, `list_my_posts` |
| Safety | `report`, `block_user`, `unblock_user`, `list_blocked` |
| Notifications | `list_notifications`, `unread_notification_count`, `mark_notifications_read`, `register_push_token`, `unregister_push_token` |
| Companies | `list_companies` (search, paging), `get_company` |
| Polls, saved, search | `create_post` with `p_poll`, `vote_poll`, `set_saved`, `list_saved_posts`, `search_posts` |
| Question of the week | `get_weekly_question`; moderators: `mod_add_weekly_question`, `mod_list_weekly_questions` |
| Moderators | `mod_list_queue`, `mod_claim`, `mod_resolve` (approve, remove, suspend, ban), `mod_list_companies`, `mod_update_company`, `mod_create_invites` |
| Edge functions only | `svc_*` (service role) |

Rules worth knowing:
- `company` posts are visible only to verified members of the same company. `all` lists everything that is not a company post.
- A block hides both people from each other everywhere, immediately.
- Three different reporters hide an item until a moderator decides (`auto_hold_reports`).
- Limits: 5 posts an hour and 20 a day, 30 comments an hour, 30 reports a day, a new handle once a week.
- The filter refuses phone numbers, national ID or iqama numbers, IBANs, email addresses, slurs and explicit words. Insults, crime accusations and links are saved but held for a moderator. The word list is the table `public.filter_terms`; edit it freely.
- The directory lists every reviewed company (`listed`) plus any company that has a member. A company's page shows its name, sector, icon and two counts to everyone; its posts are the `company` channel and stay behind the wall.
- A poll is a post with 2 to 4 choices. One vote per member, never changed; who chose what is stored only to stop double voting and is shown to nobody.
- The question of the week is a post by the house (author `wrk.`), answered in its comments. The next unused row of `public.weekly_questions` becomes a post the first time anyone opens the app after Sunday 00:00 Riyadh time. 26 questions are seeded; when they run out the oldest comes round again. Add your own from the console.
- Search matches post text after the same normalisation the filter uses (hamza forms, ta marbuta, tashkeel), only in posts the member may see.
- A like notifies the author once per post while unread; a used invitation notifies its owner without saying who joined.
- Each member gets 3 invitations (`invites_per_member` in `app_settings`, applies to members who join after a change).
- Unknown employers are created on first sign-in with the domain as the name. Rename them in the SQL editor (`update public.companies set name = 'الاسم', sector = 'القطاع' where domain = 'example.com';`). To refuse a domain, add it to `public.blocked_email_domains` with kind `manual`.

## Tests

```
cd tests
npm install
npm test          # rebuilds two scratch databases and runs the 34 tests
npm run typecheck # type-checks the edge functions against the real SDK types
```
They need a local PostgreSQL 15+ (`TEST_DATABASE_URL`, default `postgres://postgres:postgres@127.0.0.1:5432/wrk_test`) and the app checkout next to this folder (`WRK_APP_DIR`). `tests/supabase-shim.sql` supplies the Supabase roles and `auth.uid()`, so the real migrations run unchanged and every call is made as the `anon` or `authenticated` role, the way Supabase makes it.

### What has and has not been run

Run and passing here: all migrations on PostgreSQL 16; the app's real client through the real edge-function logic into the real database functions (the three doors, invitations, the shop lookup against a fake shop, adding a work email, free-mail refusal, hashing, the company wall, the filter, blocks, reports, the moderator flow, AI verdict handling, push batching, export, erasure, retention; the directory and its search, the company page, icon selection and storage against a fake web and a fake bucket, icon takedown, polls, the question of the week, saved posts, search); type-checking of the edge functions against `@supabase/supabase-js` and `@anthropic-ai/sdk`.

Not run, because a live Supabase project cannot be created from the build machine: `supabase db push` against a hosted project, the deployed Deno functions, the Supabase Auth calls inside `auth-verify-code` (`createUser`, `generateLink`, then `verifyOtp` in the app), a real email through Resend, the live shop's buyer route, a real Claude verdict, a real Expo push, and any real company icon: the build machine's network refused every outside site, so `company-icons` has never fetched a live page and none of the 278 domains has been checked against the live web. Expect some companies to come back without an icon, and review the list once (`select name, domain from public.companies where listed and icon_url is null and icon_checked_at is not null;`). If step 2 or the first sign-in fails, the likely causes are:
- `verifyOtp` rejects the token: the client already retries with type `email`; if both fail, check that the Email provider is enabled under Authentication, Providers.
- `createUser` rejects the placeholder address: set `SYNTHETIC_EMAIL_DOMAIN` to a domain you own (no mail is ever sent to it) and redeploy.
- A company's members land in a new, unnamed company instead of the seeded one: its real mailbox domain differs from the one in the list. Add it as an alias: `insert into private.company_domains (domain, company_id) select 'real-domain.com', id from public.companies where domain = 'listed-domain.com';`
- `pg_cron` could not be enabled by the migration: enable it under Database, Extensions, then run `select cron.schedule('wrk-retention', '*/5 * * * *', 'select private.run_retention()');`
