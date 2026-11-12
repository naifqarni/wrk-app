# wrk. community: data handling (PDPL)

This describes what the backend does. It is not legal advice; the items at the end need a Saudi lawyer before launch.

## What is stored about a member

| Data | Where | Why |
|---|---|---|
| Keyed one-way hash of the work email | `private.identities` | So the same email reaches the same account, and a banned identity cannot return |
| Company (from the email domain), if the member joined with or later added a work email | `members.company_id` | Shown beside the handle; decides who sees the company channel |
| Which door they came through (invitation or purchase) | `members.access` | Membership rule |
| Invitation codes: who owns each, and which member used it | `invites` | Single use; lets a moderator see who invited an abusive account. Members only ever see their own codes and whether each was used |
| Keyed hash of a second, work address (if added) | `private.work_identities` | Either address signs the member in |
| Random handle, show-company choice, role, status, dates of joining, verification and rules acceptance | `members` | The pseudonymous profile |
| Posts, comments, likes, blocks, reports made | their tables | The product |
| Saved posts | `saved_posts` | The member's private reading list; nobody else can see it |
| Poll votes: which choice a member picked | `poll_votes` | Only to stop double voting. Totals are shown; who chose what is shown to nobody, moderators included, through any function |
| Push token, if notifications are allowed | `push_tokens` | Delivering notifications |

## What is never stored

The email address itself, a name, a phone number, a photo, a location, a device identifier, an advertising identifier, contact lists, or the network address. A network address is used once, as a hash that changes daily, to limit sign-in code abuse, and is deleted within a day. The Supabase auth user holds a random placeholder instead of an email. Function logs never print an address or a code.

Two limits to state honestly in the privacy policy. First, the sign-in form answers differently for a member, a customer and a stranger, so in principle it tells someone whether an address they type has an account or an order; this is capped at 15 tries a day per address and 30 an hour per network address. Second: the operator, holding the secret key, can check whether one given email address has an account. The operator cannot produce a list of addresses, and a copy of the database without the key reveals nothing about who the members are.

## Retention (automatic, every 5 minutes via `private.run_retention()`)

| Data | Kept |
|---|---|
| Sign-in codes, the record of sign-in attempts, and the daily network-address hash | 24 hours |
| Content removed by moderation | 90 days (appeals, lawful requests), then destroyed |
| Notifications | 90 days |
| Closed reports: who reported and their note | 180 days, then anonymised |
| Closed moderation cases and the action log | 1 year |
| Everything owned by a member who deletes their account | destroyed immediately |
| Ban record (hash only) | kept, so a banned identity cannot re-register |

## Member rights

- **Access and portability:** `export_my_data()` returns everything held about the member as JSON (`exportMyData()` in the app).
- **Erasure:** `delete_my_account()` removes the account, the hash, and all posts, comments, likes, blocks, notifications and tokens at once (`deleteAccount()` in the app; Apple requires this in-app).
- **Correction:** there is no personal data to correct beyond the handle, which the member can regenerate.
- **Consent:** the community rules must be accepted before the first post; the date and version are recorded. Raising `rules_version` in `app_settings` asks everyone again.

## Processors and where data goes

| Service | Receives | Note |
|---|---|---|
| Supabase | The database and functions | Region is chosen at project creation. If no in-Kingdom region is offered, this is a transfer outside KSA under PDPL and needs a legal basis and disclosure |
| The wrk. shop (your own server) | The email typed on the "bought from wrk." door, to answer yes or no | The shop already holds its customers' order emails. The community does not keep the answer, and does not record which order or what was bought |
| Resend | The email and the code, for one message | The only party besides the member that sees the address. Its delivery logs retain it; set the shortest retention the plan allows |
| Anthropic (only if AI review is on) | The text of a post or comment and its channel, no member or company identifiers | Disclose automated review in the privacy policy |
| Company websites (icon fetch) | One ordinary page request from the server, for companies in the reviewed list only | No member data is involved. Phones never contact a company's server: they load our stored copy |
| Expo, Apple, Google (only if push is on) | A device token and a generic line of text | No user content |

## Company names and icons

The directory names companies and shows each one's own site icon so members can recognise where someone works. This is identification, the way a jobs board or a professional network shows an employer. It is not endorsement, and the marks remain their owners'.

Rules the code keeps:
- The icon is a byte-for-byte copy of what the company publishes as its site icon. It is never redrawn, recoloured, cropped or combined with wrk. artwork. A company without a usable icon gets a plain wrk. monogram of its first letter.
- Icons are fetched only for companies reviewed by hand (`companies.listed`), never for a domain a member typed.
- `companies.icon_hidden` removes an icon from every screen at once, and the stored copy is deleted on the next run. `icon_source` records where each copy came from.

Rules for you:
- Do not use any company's name or icon in marketing, screenshots for the stores, or anything that suggests the company is a partner or approves of what is written about it.
- Publish a contact address for companies. If one asks for its icon or its listing to be removed, do it the same day (console: "إخفاء الأيقونة"; to remove the listing: `update public.companies set listed = false where domain = '...'`, which hides it from the directory unless it has members).
- Trademark and unfair-competition risk under Saudi law is low for plain identification but not zero, and it rises sharply if a company is unhappy with posts about it. Add this to the lawyer's review below.

## Requests from authorities

Keep a written procedure. What exists to hand over for a specific account: the handle, company, timestamps, and content. What does not exist: the email, name, phone or network address. Given a specific email address and the secret key, the matching account can be found. Removed content is available for 90 days.

## Still needed from you before launch

1. A Saudi lawyer's review of anonymous workplace speech under the Anti-Cyber Crime Law, and of the terms and community rules text.
2. A privacy policy in Arabic that matches this document, linked in the app and the stores.
3. An assessment of whether registration with SDAIA's national data governance platform is required, and a record of processing activities.
4. The lawyer's view on showing company names and icons (see "Company names and icons"), and one pass over the 278 seeded companies: names, sectors and mailbox domains were written from general knowledge and not checked against the live web.
5. A named person who reviews the moderation queue daily (24-hour deadline), and a contact address for takedown requests.
5. A decision on minimum age (the rules should say 18+; work email already implies employment).
6. A breach plan: who notifies SDAIA within 72 hours and how members are told.
