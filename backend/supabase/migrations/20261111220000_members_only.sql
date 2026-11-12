-- wrk. community becomes members-only.
--
-- A new person gets in one of two ways:
--   invite : a single-use code from a member (or minted by a moderator) + a work email
--   buyer  : the email they ordered with from the wrk. store (personal mail allowed)
-- A returning member signs in with just their email. Nothing is readable signed out.
-- Emails are still never stored: only the keyed hash, as before.

-- ------------------------------------------------------------------ tables ---
alter table public.members alter column company_id drop not null;
alter table public.members add column access text not null default 'invite' check (access in ('invite','buyer'));
alter table public.posts alter column company_id drop not null;
alter table public.posts add constraint posts_company_channel_has_company
  check (channel <> 'company' or company_id is not null);

create table public.invites (
  code       text primary key,                 -- WRK-7Q4K-2M9X
  owner_id   uuid references public.members(id) on delete cascade,   -- null: minted by the house
  used_by    uuid references public.members(id) on delete set null,
  used_at    timestamptz,
  note       text,
  created_at timestamptz not null default now()
);
create index invites_owner_idx on public.invites (owner_id);

-- A second address for the same member: the employer mailbox a buyer adds later,
-- or a new employer after changing jobs. Either address signs the member in.
create table private.work_identities (
  member_id  uuid primary key references auth.users(id) on delete cascade,
  email_hash text not null unique,
  created_at timestamptz not null default now()
);

alter table private.email_challenges
  add column purpose     text not null default 'signin' check (purpose in ('signin','work')),
  add column access      text check (access in ('invite','buyer')),
  add column invite_code text,
  add column member_id   uuid;

-- Every request for a code, successful or not, so nobody can use the sign-in
-- form to test which addresses are members or customers. Kept for one day.
create table private.signin_attempts (
  id         bigint generated always as identity primary key,
  email_hash text not null,
  ip_hash    text,
  created_at timestamptz not null default now()
);
create index signin_attempts_hash_idx on private.signin_attempts (email_hash, created_at desc);
create index signin_attempts_ip_idx on private.signin_attempts (ip_hash, created_at desc);

alter table public.invites enable row level security;
alter table private.work_identities enable row level security;
alter table private.signin_attempts enable row level security;
revoke all on table public.invites, private.work_identities, private.signin_attempts from public;
do $$ begin
  execute 'revoke all on table public.invites, private.work_identities, private.signin_attempts from anon, authenticated';
exception when undefined_object then null; end $$;

insert into public.app_settings (key, value) values ('invites_per_member', '3') on conflict (key) do nothing;

-- ----------------------------------------------------------------- invites ---
-- "wrk7q4k 2m9x" -> "WRK-7Q4K-2M9X"; null when it cannot be a code
create or replace function private.normalize_invite(p_code text) returns text
language sql immutable set search_path = '' as $$
  select case when c ~ '^WRK[2-9A-HJ-KM-NP-Z]{8}$'
              then 'WRK-' || substr(c, 4, 4) || '-' || substr(c, 8, 4) end
  from (select regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g') as c) s
$$;

create or replace function private.gen_invite_code() returns text
language plpgsql set search_path = '' as $$
declare
  alphabet text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   -- no 0 O 1 I L
  raw text;
  v_code text;
begin
  loop
    raw := '';
    for i in 1..8 loop
      raw := raw || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    v_code := 'WRK-' || substr(raw, 1, 4) || '-' || substr(raw, 5, 4);
    exit when not exists (select 1 from public.invites i where i.code = v_code);
  end loop;
  return v_code;
end $$;

-- Run this in the SQL editor to create the first invitations:
--   select * from private.mint_invites(null, 10, 'launch');
create or replace function private.mint_invites(p_owner uuid, p_count int, p_note text default null)
returns setof text
language plpgsql set search_path = '' as $$
declare v_code text;
begin
  for i in 1..least(greatest(coalesce(p_count, 1), 1), 500) loop
    v_code := private.gen_invite_code();
    insert into public.invites (code, owner_id, note) values (v_code, p_owner, p_note);
    return next v_code;
  end loop;
end $$;

-- Signed-out callable: the signup screen checks a code before asking for an email.
create or replace function public.check_invite(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('valid', exists (
    select 1 from public.invites i where i.code = private.normalize_invite(p_code) and i.used_at is null))
$$;

create or replace function public.list_my_invites() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.members := private.viewer('member');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('code', i.code, 'usedAt', private.ts(i.used_at))
                                    order by i.created_at, i.code)
                   from public.invites i where i.owner_id = v.id), '[]'::jsonb);
end $$;

create or replace function public.mod_create_invites(p_count int default 1, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.members := private.moderator(); v_codes text[];
begin
  select array(select private.mint_invites(null, least(greatest(coalesce(p_count, 1), 1), 50),
                                           nullif(left(btrim(coalesce(p_note, '')), 200), ''))) into v_codes;
  insert into public.moderation_actions (moderator_id, action, target_type, target_id, note)
  values (v.id, 'mint-invites', 'user', v.id, array_length(v_codes, 1)::text || coalesce(' / ' || p_note, ''));
  return (select jsonb_agg(jsonb_build_object('code', c, 'usedAt', null) order by c) from unnest(v_codes) c);
end $$;

-- ----------------------------------------------------------------- sign-in ---
-- 'ok' (a work domain) | 'free' | 'disposable' | 'blocked' | 'invalid'
create or replace function private.domain_kind(p_domain text) returns text
language plpgsql stable set search_path = '' as $$
declare d text := lower(btrim(coalesce(p_domain, ''))); r text; k text;
begin
  if d !~ '^([a-z0-9]([a-z0-9\-]*[a-z0-9])?\.)+[a-z]{2,}$' then return 'invalid'; end if;
  r := private.registrable_domain(d);
  select case when count(*) = 0 then null when bool_or(b.kind = 'disposable') then 'disposable' else 'free' end into k
    from public.blocked_email_domains b
   where b.domain in (d, r) or (position('.' in b.domain) = 0 and b.domain = split_part(r, '.', 1));
  if k is not null then return k; end if;
  if exists (select 1 from public.companies c
             left join private.company_domains cd on cd.company_id = c.id
             where c.status = 'blocked' and (c.domain = r or cd.domain in (d, r))) then
    return 'blocked';
  end if;
  return 'ok';
end $$;

create or replace function private.member_for_hash(p_email_hash text) returns uuid
language sql stable set search_path = '' as $$
  select coalesce((select member_id from private.identities where email_hash = p_email_hash),
                  (select member_id from private.work_identities where email_hash = p_email_hash))
$$;

drop function if exists public.svc_start_email_challenge(text, text, text, text);
drop function if exists public.svc_verify_email_challenge(text, text);
drop function if exists public.svc_complete_signin(uuid, text);

-- Step 1. p_access: member | invite | buyer.
-- For a new buyer the first call answers 'need-buyer-check'; the edge function
-- asks the shop whether an order exists for that address and calls again with
-- p_buyer_confirmed = true or false.
create or replace function public.svc_start_email_challenge(
  p_email_hash text, p_domain text, p_code_hash text, p_ip_hash text default null,
  p_access text default 'member', p_invite_code text default null, p_buyer_confirmed boolean default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := private.domain_kind(p_domain);
  v_member uuid;
  v_access text;
  v_code text;
  v_used timestamptz;
  v_company text;
  err constant text := 'error';
begin
  if v_kind = 'invalid' then return jsonb_build_object('ok', false, err, 'invalid-email'); end if;
  if exists (select 1 from private.banned_identities where email_hash = p_email_hash) then
    return jsonb_build_object('ok', false, err, 'forbidden');
  end if;

  -- count the attempt whatever its outcome (once per request, not on the buyer re-call)
  if p_buyer_confirmed is null then
    if (select count(*) from private.signin_attempts where email_hash = p_email_hash and created_at > now() - interval '1 day') >= 15
       or (p_ip_hash is not null and
           (select count(*) from private.signin_attempts where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 30)
    then
      return jsonb_build_object('ok', false, err, 'rate-limited');
    end if;
    insert into private.signin_attempts (email_hash, ip_hash) values (p_email_hash, p_ip_hash);
  end if;

  v_member := private.member_for_hash(p_email_hash);
  if v_member is null then
    if v_kind = 'disposable' then return jsonb_build_object('ok', false, err, 'free-mail'); end if;
    if v_kind = 'blocked' then return jsonb_build_object('ok', false, err, 'forbidden'); end if;
    if p_access = 'invite' then
      if v_kind = 'free' then return jsonb_build_object('ok', false, err, 'free-mail'); end if;
      v_code := private.normalize_invite(p_invite_code);
      select used_at into v_used from public.invites where code = v_code;
      if not found then return jsonb_build_object('ok', false, err, 'not-invited'); end if;
      if v_used is not null then return jsonb_build_object('ok', false, err, 'invite-used'); end if;
      v_access := 'invite';
    elsif p_access = 'buyer' then
      if p_buyer_confirmed is null then return jsonb_build_object('ok', false, err, 'need-buyer-check'); end if;
      if not p_buyer_confirmed then return jsonb_build_object('ok', false, err, 'no-purchase'); end if;
      v_access := 'buyer';
    else
      return jsonb_build_object('ok', false, err, 'not-a-member');
    end if;
  end if;

  -- one code a minute, 3 per 15 minutes, 10 a day per address; 20 an hour per network address
  if exists (select 1 from private.email_challenges where email_hash = p_email_hash and created_at > now() - interval '60 seconds')
     or (select count(*) from private.email_challenges where email_hash = p_email_hash and created_at > now() - interval '15 minutes') >= 3
     or (select count(*) from private.email_challenges where email_hash = p_email_hash and created_at > now() - interval '1 day') >= 10
     or (p_ip_hash is not null and
         (select count(*) from private.email_challenges where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 20)
  then
    return jsonb_build_object('ok', false, err, 'rate-limited');
  end if;

  update private.email_challenges set consumed_at = now()
   where email_hash = p_email_hash and consumed_at is null and purpose = 'signin';
  insert into private.email_challenges (email_hash, domain, code_hash, ip_hash, expires_at, purpose, access, invite_code)
  values (p_email_hash, lower(btrim(p_domain)), p_code_hash, p_ip_hash, now() + interval '10 minutes', 'signin', v_access, v_code);

  if v_kind = 'ok' then
    select c.name into v_company from public.companies c where c.domain = private.registrable_domain(p_domain);
  end if;
  return jsonb_build_object('ok', true, 'expiresInSeconds', 600, 'companyName', v_company, 'returning', v_member is not null);
end $$;

-- Step 2: is the code right? Five wrong tries burn the code.
create or replace function public.svc_verify_email_challenge(p_email_hash text, p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ch private.email_challenges; v_member uuid;
begin
  select * into ch from private.email_challenges
   where email_hash = p_email_hash and purpose = 'signin' and consumed_at is null and expires_at > now()
   order by created_at desc limit 1 for update;
  if ch.id is null then return jsonb_build_object('ok', false, 'error', 'bad-code'); end if;
  if ch.code_hash <> p_code_hash then
    update private.email_challenges
       set attempts = attempts + 1, consumed_at = case when attempts + 1 >= 5 then now() end
     where id = ch.id;
    return jsonb_build_object('ok', false, 'error', 'bad-code');
  end if;
  if exists (select 1 from private.banned_identities where email_hash = p_email_hash) then
    update private.email_challenges set consumed_at = now() where id = ch.id;
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  v_member := private.member_for_hash(p_email_hash);
  if v_member is null and ch.access = 'invite'
     and not exists (select 1 from public.invites where code = ch.invite_code and used_at is null) then
    update private.email_challenges set consumed_at = now() where id = ch.id;
    return jsonb_build_object('ok', false, 'error', 'invite-used');   -- someone else used it in the meantime
  end if;
  if v_member is null and ch.access is null then
    update private.email_challenges set consumed_at = now() where id = ch.id;
    return jsonb_build_object('ok', false, 'error', 'not-a-member');   -- the account was deleted after the code was sent
  end if;
  update private.email_challenges set consumed_at = now() where id = ch.id;
  return jsonb_build_object('ok', true, 'memberId', v_member, 'domain', ch.domain);
end $$;

-- Step 3: create the member (consuming the invite) or refresh a returning one.
-- Refuses unless a code for this hash was confirmed in the last five minutes.
create or replace function public.svc_complete_signin(p_user_id uuid, p_email_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ch private.email_challenges; v_member uuid; m public.members; v_company uuid;
begin
  select * into ch from private.email_challenges
   where email_hash = p_email_hash and purpose = 'signin'
     and consumed_at > now() - interval '5 minutes' and attempts < 5
   order by consumed_at desc limit 1;
  if ch.id is null then return jsonb_build_object('ok', false, 'error', 'bad-code'); end if;

  v_member := private.member_for_hash(p_email_hash);
  if v_member is null then
    if p_user_id is null or ch.access is null then return jsonb_build_object('ok', false, 'error', 'unknown'); end if;
    if private.domain_kind(ch.domain) = 'ok' then v_company := private.company_for_domain(ch.domain); end if;
    if ch.access = 'invite' and v_company is null then return jsonb_build_object('ok', false, 'error', 'free-mail'); end if;
    insert into private.identities (member_id, email_hash) values (p_user_id, p_email_hash);
    insert into public.members (id, handle, company_id, access)
    values (p_user_id, private.gen_handle(), v_company, ch.access)
    returning * into m;
    if ch.access = 'invite' then
      update public.invites set used_by = m.id, used_at = now() where code = ch.invite_code and used_at is null;
      if not found then raise exception 'invite-used' using errcode = 'P0001'; end if;   -- undoes the member too
    end if;
    perform private.mint_invites(m.id, private.setting_int('invites_per_member'));
  else
    select * into m from public.members where id = v_member;
    if m.status = 'banned' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
    -- signing in with the employer's mailbox re-confirms the employer
    if m.company_id is not null and (
         exists (select 1 from private.work_identities where member_id = v_member and email_hash = p_email_hash)
         or not exists (select 1 from private.work_identities where member_id = v_member)) then
      update public.members set verified_at = now() where id = v_member returning * into m;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'memberId', m.id, 'isNew', v_member is null);
end $$;

-- A signed-in member adds (or changes) their employer mailbox.
create or replace function public.svc_start_work_email(p_member uuid, p_email_hash text, p_domain text, p_code_hash text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_kind text := private.domain_kind(p_domain); v_other uuid; m public.members;
begin
  select * into m from public.members where id = p_member;
  if m.id is null then return jsonb_build_object('ok', false, 'error', 'not-verified'); end if;
  if m.status <> 'active' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if v_kind = 'invalid' then return jsonb_build_object('ok', false, 'error', 'invalid-email'); end if;
  if v_kind in ('free','disposable') then return jsonb_build_object('ok', false, 'error', 'free-mail'); end if;
  if v_kind = 'blocked' or exists (select 1 from private.banned_identities where email_hash = p_email_hash) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if exists (select 1 from private.email_challenges where member_id = p_member and purpose = 'work' and created_at > now() - interval '60 seconds')
     or (select count(*) from private.email_challenges where member_id = p_member and purpose = 'work' and created_at > now() - interval '15 minutes') >= 3
     or (select count(*) from private.email_challenges where member_id = p_member and purpose = 'work' and created_at > now() - interval '1 day') >= 10
  then
    return jsonb_build_object('ok', false, 'error', 'rate-limited');
  end if;
  v_other := private.member_for_hash(p_email_hash);
  if v_other is not null and v_other <> p_member then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  update private.email_challenges set consumed_at = now() where member_id = p_member and purpose = 'work' and consumed_at is null;
  insert into private.email_challenges (email_hash, domain, code_hash, expires_at, purpose, member_id)
  values (p_email_hash, lower(btrim(p_domain)), p_code_hash, now() + interval '10 minutes', 'work', p_member);
  return jsonb_build_object('ok', true, 'expiresInSeconds', 600);
end $$;

create or replace function public.svc_verify_work_email(p_member uuid, p_email_hash text, p_code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ch private.email_challenges; v_other uuid;
begin
  select * into ch from private.email_challenges
   where member_id = p_member and email_hash = p_email_hash and purpose = 'work'
     and consumed_at is null and expires_at > now()
   order by created_at desc limit 1 for update;
  if ch.id is null then return jsonb_build_object('ok', false, 'error', 'bad-code'); end if;
  if ch.code_hash <> p_code_hash then
    update private.email_challenges
       set attempts = attempts + 1, consumed_at = case when attempts + 1 >= 5 then now() end
     where id = ch.id;
    return jsonb_build_object('ok', false, 'error', 'bad-code');
  end if;
  update private.email_challenges set consumed_at = now() where id = ch.id;
  v_other := private.member_for_hash(p_email_hash);
  if v_other is not null and v_other <> p_member then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  -- the address they joined with stays their sign-in; this one is kept beside it
  if not exists (select 1 from private.identities where member_id = p_member and email_hash = p_email_hash) then
    insert into private.work_identities (member_id, email_hash) values (p_member, p_email_hash)
    on conflict (member_id) do update set email_hash = excluded.email_hash, created_at = now();
  else
    delete from private.work_identities where member_id = p_member;
  end if;
  update public.members set company_id = private.company_for_domain(ch.domain), verified_at = now() where id = p_member;
  return jsonb_build_object('ok', true);
end $$;

-- ----------------------------------------------- members may have no company ---
create or replace function private.me_json(m public.members) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id,
    'handle', m.handle,
    'companyId', c.id,
    'companyName', c.name,
    'showCompany', m.show_company,
    'acceptedRulesAt', case when coalesce(m.rules_version, 0) >= private.setting_int('rules_version')
                            then private.ts(m.accepted_rules_at) end,
    'role', m.role,
    'access', m.access,
    'invitesLeft', (select count(*) from public.invites i where i.owner_id = m.id and i.used_at is null),
    'companyMemberCount', case when c.id is null then 0 else (select count(*) from public.members x where x.company_id = c.id and x.status <> 'banned') end,
    'verifiedUntil', private.ts(private.verified_until(m)),
    'suspended', m.status = 'suspended' and (m.suspended_until is null or m.suspended_until > now()))
  from (select 1) one left join public.companies c on c.id = m.company_id
$$;

create or replace function private.author_json(p_member uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object(
        'id', m.id,
        'handle', m.handle,
        'companyLabel', case when m.show_company then c.name else c.sector end)
     from public.members m left join public.companies c on c.id = m.company_id
     where m.id = p_member),
    jsonb_build_object('id', 'deleted', 'handle', 'عضو سابق', 'companyLabel', null))
$$;

-- ------------------------------------------------- reading is for members only ---
create or replace function public.list_channels() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.members := private.viewer('member');
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'companyOnly', company_only) order by sort), '[]'::jsonb)
          from public.channels);
end $$;

create or replace function public.list_posts(p_channel text, p_cursor text default null, p_limit int default 20)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.members := private.viewer('member');
  n int := private.page_limit(p_limit);
  c_ts timestamptz; c_id uuid;
  rows public.posts[];
  v_next text;
begin
  if not exists (select 1 from public.channels where id = p_channel) then perform private.fail('not-found'); end if;
  if p_channel = 'company' then
    if v.company_id is null or private.verified_until(v) <= now() then perform private.fail('not-verified'); end if;
  end if;
  if p_cursor is not null then
    begin
      c_ts := split_part(p_cursor, '|', 1)::timestamptz; c_id := split_part(p_cursor, '|', 2)::uuid;
    exception when others then perform private.fail('not-found'); end;
  end if;

  select array(
    select p from public.posts p
    where (case when p_channel = 'all' then p.channel <> 'company' else p.channel = p_channel end)
      and (p_channel <> 'company' or p.company_id = v.company_id)
      and private.can_see_post(p, v)
      and (c_ts is null or (p.created_at, p.id) < (c_ts, c_id))
    order by p.created_at desc, p.id desc
    limit n + 1) into rows;

  if coalesce(array_length(rows, 1), 0) > n then
    v_next := private.cursor_of(rows[n].created_at, rows[n].id);
    rows := rows[1:n];
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.post_json(r, v.id) order by r.created_at desc, r.id desc) from unnest(rows) r), '[]'::jsonb),
    'nextCursor', v_next);
end $$;

create or replace function public.get_post(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.members := private.viewer('member');
begin
  return private.post_json(private.visible_post(p_id, v), v.id);
end $$;

create or replace function public.list_comments(p_post_id uuid, p_cursor text default null, p_limit int default 20)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.members := private.viewer('member');
  n int := private.page_limit(p_limit);
  c_ts timestamptz; c_id uuid;
  rows public.comments[];
  v_next text;
begin
  perform private.visible_post(p_post_id, v);
  if p_cursor is not null then
    begin
      c_ts := split_part(p_cursor, '|', 1)::timestamptz; c_id := split_part(p_cursor, '|', 2)::uuid;
    exception when others then perform private.fail('not-found'); end;
  end if;
  select array(
    select c from public.comments c
    where c.post_id = p_post_id
      and (c.status = 'published' or (v.id is not null and c.author_id = v.id and c.status in ('pending','held')))
      and not private.is_blocked(v.id, c.author_id)
      and (c_ts is null or (c.created_at, c.id) > (c_ts, c_id))
    order by c.created_at, c.id limit n + 1) into rows;
  if coalesce(array_length(rows, 1), 0) > n then
    v_next := private.cursor_of(rows[n].created_at, rows[n].id);
    rows := rows[1:n];
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.comment_json(r, v.id) order by r.created_at, r.id) from unnest(rows) r), '[]'::jsonb),
    'nextCursor', v_next);
end $$;

create or replace function public.create_post(p_channel text, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.members := private.viewer('post');
  v_body text := btrim(coalesce(p_body, ''), E' \n\r\t');
  v_first text;
  p public.posts;
begin
  if not exists (select 1 from public.channels where id = p_channel) then perform private.fail('not-found'); end if;
  -- an employer shown beside the handle must have been confirmed in the last 12 months;
  -- a buyer without an employer can post everywhere except the company channel
  if v.company_id is not null and private.verified_until(v) <= now() then perform private.fail('not-verified'); end if;
  if p_channel = 'company' and v.company_id is null then perform private.fail('not-verified'); end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then perform private.fail('filtered'); end if;
  if (select count(*) from public.posts where author_id = v.id and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.posts where author_id = v.id and created_at > now() - interval '1 day') >= 20
     or exists (select 1 from public.posts where author_id = v.id and body = v_body and created_at > now() - interval '10 minutes') then
    perform private.fail('rate-limited');
  end if;

  v_first := private.first_status(v_body);
  insert into public.posts (channel, author_id, company_id, body, status)
  values (p_channel, v.id, v.company_id, v_body, split_part(v_first, ':', 1))
  returning * into p;

  if p.status = 'published' then
    perform private.mark_published('post', p.id);
  elsif p.status = 'held' then
    perform private.enqueue('post', p.id, v.id, 'filter', split_part(v_first, ':', 2));
  end if;
  select * into p from public.posts where id = p.id;
  return private.post_json(p, v.id);
end $$;

create or replace function public.create_comment(p_post_id uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.members := private.viewer('post');
  v_body text := btrim(coalesce(p_body, ''), E' \n\r\t');
  v_post public.posts;
  v_first text;
  c public.comments;
begin
  v_post := private.visible_post(p_post_id, v);
  if v_post.status <> 'published' and v_post.author_id <> v.id then perform private.fail('not-found'); end if;
  if v.company_id is not null and private.verified_until(v) <= now() then perform private.fail('not-verified'); end if;
  if char_length(v_body) < 1 or char_length(v_body) > 800 then perform private.fail('filtered'); end if;
  if (select count(*) from public.comments where author_id = v.id and created_at > now() - interval '1 hour') >= 30
     or (select count(*) from public.comments where author_id = v.id and created_at > now() - interval '1 day') >= 200
     or exists (select 1 from public.comments where author_id = v.id and post_id = p_post_id and body = v_body
                and created_at > now() - interval '10 minutes') then
    perform private.fail('rate-limited');
  end if;

  v_first := private.first_status(v_body);
  insert into public.comments (post_id, author_id, body, status)
  values (p_post_id, v.id, v_body, split_part(v_first, ':', 1))
  returning * into c;

  if c.status = 'published' then
    perform private.mark_published('comment', c.id);
  elsif c.status = 'held' then
    perform private.enqueue('comment', c.id, v.id, 'filter', split_part(v_first, ':', 2));
  end if;
  select * into c from public.comments where id = c.id;
  return private.comment_json(c, v.id);
end $$;

-- ------------------------------------------------------- privacy and upkeep ---
create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.members := private.viewer('member');
begin
  return jsonb_build_object(
    'exportedAt', private.ts(now()),
    'note', 'wrk. does not store your email address, name or phone number. Your account is linked to a one-way keyed hash of your work email and to your company domain.',
    'profile', private.me_json(v) || jsonb_build_object(
        'companyDomain', (select domain from public.companies where id = v.company_id),
        'hasSeparateWorkEmail', exists (select 1 from private.work_identities w where w.member_id = v.id),
        'joinedAt', private.ts(v.created_at), 'verifiedAt', private.ts(v.verified_at), 'status', v.status),
    'posts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'channel', channel, 'body', body,
                'status', status, 'createdAt', private.ts(created_at)) order by created_at)
              from public.posts where author_id = v.id), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'postId', post_id, 'body', body,
                'status', status, 'createdAt', private.ts(created_at)) order by created_at)
              from public.comments where author_id = v.id), '[]'::jsonb),
    'likes', coalesce((select jsonb_agg(jsonb_build_object('postId', post_id, 'createdAt', private.ts(created_at)))
              from public.post_likes where member_id = v.id), '[]'::jsonb),
    'blocked', coalesce((select jsonb_agg(jsonb_build_object('userId', blocked_id, 'createdAt', private.ts(created_at)))
              from public.blocks where blocker_id = v.id), '[]'::jsonb),
    'reportsIMade', coalesce((select jsonb_agg(jsonb_build_object('targetType', target_type, 'targetId', target_id,
                'reason', reason, 'note', note, 'status', status, 'createdAt', private.ts(created_at)))
              from public.reports where reporter_id = v.id), '[]'::jsonb),
    'notifications', coalesce((select jsonb_agg(jsonb_build_object('type', type, 'postId', post_id,
                'createdAt', private.ts(created_at), 'read', read_at is not null))
              from public.notifications where member_id = v.id), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'usedAt', private.ts(used_at)) order by created_at, code)
              from public.invites where owner_id = v.id), '[]'::jsonb),
    'pushDevices', (select count(*) from public.push_tokens where member_id = v.id));
end $$;

create or replace function private.ban_member(p_member uuid, p_reason text) returns void
language plpgsql set search_path = '' as $$
begin
  update public.members set status = 'banned', suspended_until = null where id = p_member;
  update public.posts set status = 'removed' where author_id = p_member and status <> 'removed';
  update public.comments set status = 'removed' where author_id = p_member and status <> 'removed';
  delete from public.push_tokens where member_id = p_member;
  delete from public.invites where owner_id = p_member and used_at is null;   -- their unused invitations die with the ban
  insert into private.banned_identities (email_hash, reason)
  select email_hash, p_reason from private.identities where member_id = p_member
  union select email_hash, p_reason from private.work_identities where member_id = p_member
  on conflict (email_hash) do nothing;
end $$;

create or replace function private.run_retention() returns jsonb
language plpgsql set search_path = '' as $$
declare a int; b int; c int; d int; e int; f int;
begin
  a := private.release_stale_pending();
  -- sign-in codes and the network-address hashes that came with them: one day
  delete from private.email_challenges where created_at < now() - interval '1 day';
  get diagnostics b = row_count;
  delete from private.signin_attempts where created_at < now() - interval '1 day';
  -- removed content is kept 90 days for appeals and lawful requests, then destroyed
  delete from public.posts where status = 'removed' and removed_at < now() - interval '90 days';
  get diagnostics c = row_count;
  delete from public.comments where status = 'removed' and removed_at < now() - interval '90 days';
  get diagnostics d = row_count;
  delete from public.notifications where created_at < now() - interval '90 days';
  get diagnostics e = row_count;
  -- closed reports: after 180 days forget who reported and what they wrote
  update public.reports set reporter_id = null, note = null
   where status = 'resolved' and resolved_at < now() - interval '180 days' and (reporter_id is not null or note is not null);
  -- closed moderation cases and their audit trail: one year
  delete from public.moderation_actions where created_at < now() - interval '1 year';
  delete from public.moderation_items where state in ('actioned','dismissed') and resolved_at < now() - interval '1 year';
  get diagnostics f = row_count;
  update public.members set status = 'active', suspended_until = null
   where status = 'suspended' and suspended_until is not null and suspended_until <= now();
  return jsonb_build_object('staleToReview', a, 'codes', b, 'posts', c, 'comments', d, 'notifications', e, 'cases', f);
end $$;

-- ------------------------------------------------------------------ grants ---
do $$
declare
  f record;
  app     text[] := array['check_invite','list_my_invites','mod_create_invites'];
  service text[] := array['svc_start_email_challenge','svc_verify_email_challenge','svc_complete_signin',
                          'svc_start_work_email','svc_verify_work_email'];
begin
  for f in select p.oid::regprocedure as sig, p.proname
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any(app || service)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any(app) then
      execute format('grant execute on function %s to anon, authenticated, service_role', f.sig);
    else
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
