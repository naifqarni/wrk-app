-- wrk. community, round 3: company directory and icons, polls, the question of
-- the week, saved posts, search, a richer notifications inbox.
-- Everything stays members-only: every function below starts by asking who is calling.

-- ------------------------------------------------------------------ tables ---
alter table public.companies
  add column name_en         text,
  add column listed          boolean not null default false,  -- reviewed by us: shown in the directory even with no members, icon may be fetched
  add column icon_url        text,                            -- a copy in OUR storage, never the company's own server
  add column icon_source     text,                            -- where the copy came from (audit, takedown requests)
  add column icon_hidden     boolean not null default false,  -- the company asked us not to show its mark
  add column icon_checked_at timestamptz,
  add column search_text     text not null default '';

create or replace function private.company_search_text() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.search_text := private.normalize_text(concat_ws(' ', new.name, new.name_en, new.sector)) || ' ' || lower(new.domain);
  return new;
end $$;
create trigger companies_search_text before insert or update of name, name_en, sector, domain on public.companies
  for each row execute function private.company_search_text();
update public.companies set listed = true, name = name;   -- the first seed was reviewed by hand; also fills search_text

-- the question of the week is a post written by the house, so a post may have no author
alter table public.posts alter column author_id drop not null;
alter table public.posts
  add column kind        text not null default 'post' check (kind in ('post','weekly')),
  add column search_text text not null default '';
alter table public.posts add constraint posts_author_unless_weekly check (kind = 'weekly' or author_id is not null);

create or replace function private.post_search_text() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.search_text := private.normalize_text(new.body);
  return new;
end $$;
create trigger posts_search_text before insert or update of body on public.posts
  for each row execute function private.post_search_text();
update public.posts set body = body;

create table public.poll_options (
  id      uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  sort    int not null,
  body    text not null check (char_length(body) between 1 and 60),
  unique (post_id, sort)
);
-- one vote per member per poll, and it cannot be changed. Who voted for what is never shown to anyone.
create table public.poll_votes (
  post_id    uuid not null references public.posts(id) on delete cascade,
  member_id  uuid not null references public.members(id) on delete cascade,
  option_id  uuid not null references public.poll_options(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, member_id)
);
create index poll_votes_option_idx on public.poll_votes (option_id);

create table public.saved_posts (
  member_id  uuid not null references public.members(id) on delete cascade,
  post_id    uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (member_id, post_id)
);
create index saved_posts_member_idx on public.saved_posts (member_id, created_at desc, post_id desc);

-- A bank of questions. Each week the next unused one becomes a post; when the
-- bank runs dry the oldest comes round again as a fresh post.
create table public.weekly_questions (
  id         uuid primary key default gen_random_uuid(),
  body       text not null check (char_length(body) between 5 and 200),
  sort       int not null default 0,
  starts_at  timestamptz unique,      -- Sunday 00:00 Riyadh time of the week it ran
  post_id    uuid references public.posts(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('comment','removed','approved','like','invite-joined'));
alter table public.notifications add column count int not null default 1;

alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
alter table public.saved_posts enable row level security;
alter table public.weekly_questions enable row level security;
revoke all on table public.poll_options, public.poll_votes, public.saved_posts, public.weekly_questions from public;
do $$ begin
  execute 'revoke all on table public.poll_options, public.poll_votes, public.saved_posts, public.weekly_questions from anon, authenticated';
exception when undefined_object then null; end $$;

-- ----------------------------------------------------------------- helpers ---
create or replace function private.like_pattern(p text) returns text
language sql immutable set search_path = '' as $$
  select '%' || replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_') || '%'
$$;

create or replace function private.offset_of(p_cursor text) returns int
language plpgsql immutable set search_path = '' as $$
begin
  if p_cursor is null then return 0; end if;
  if p_cursor !~ '^[0-9]{1,6}$' then perform private.fail('not-found'); end if;
  return p_cursor::int;
end $$;

create or replace function private.company_icon(c public.companies) returns text
language sql immutable set search_path = '' as $$
  select case when c.icon_hidden then null else c.icon_url end
$$;

create or replace function private.company_json(c public.companies, v public.members) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'nameEn', c.name_en,
    'domain', c.domain,
    'sector', c.sector,
    'iconUrl', private.company_icon(c),
    'memberCount', (select count(*) from public.members m where m.company_id = c.id and m.status <> 'banned'),
    'postCount', (select count(*) from public.posts p where p.company_id = c.id and p.channel = 'company' and p.status = 'published'),
    'mine', v.company_id is not null and v.company_id = c.id)
$$;

-- companyId / companyIconUrl only when the author shows their employer
create or replace function private.author_json(p_member uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object(
        'id', m.id,
        'handle', m.handle,
        'companyLabel', case when m.show_company then c.name else c.sector end,
        'companyId', case when m.show_company then c.id end,
        'companyIconUrl', case when m.show_company then private.company_icon(c) end)
     from public.members m left join public.companies c on c.id = m.company_id
     where m.id = p_member),
    jsonb_build_object('id', 'deleted', 'handle', 'عضو سابق', 'companyLabel', null))
$$;

create or replace function private.poll_json(p_post uuid, p_viewer uuid) returns jsonb
language sql stable set search_path = '' as $$
  select case when not exists (select 1 from public.poll_options o where o.post_id = p_post) then null else
    jsonb_build_object(
      'options', (select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.body,
                     'votes', (select count(*) from public.poll_votes pv where pv.option_id = o.id)) order by o.sort)
                  from public.poll_options o where o.post_id = p_post),
      'totalVotes', (select count(*) from public.poll_votes pv where pv.post_id = p_post),
      'myOptionId', (select pv.option_id from public.poll_votes pv where pv.post_id = p_post and pv.member_id = p_viewer))
  end
$$;

create or replace function private.post_json(p public.posts, p_viewer uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'channel', p.channel,
    'body', p.body,
    'author', case when p.kind = 'weekly'
                   then jsonb_build_object('id', 'wrk', 'handle', 'wrk.', 'companyLabel', null)
                   else private.author_json(p.author_id) end,
    'createdAt', private.ts(p.created_at),
    'likeCount', (select count(*) from public.post_likes l where l.post_id = p.id),
    'commentCount', (select count(*) from public.comments c where c.post_id = p.id and c.status = 'published'
                       and not private.is_blocked(p_viewer, c.author_id)),
    'likedByMe', p_viewer is not null and exists (select 1 from public.post_likes l where l.post_id = p.id and l.member_id = p_viewer),
    'savedByMe', p_viewer is not null and exists (select 1 from public.saved_posts s where s.post_id = p.id and s.member_id = p_viewer),
    'mine', coalesce(p_viewer is not null and p.author_id = p_viewer, false),
    'poll', private.poll_json(p.id, p_viewer),
    'status', private.client_status(p.status),
    'aiPending', p.status = 'pending')
$$;

create or replace function private.posts_page(rows public.posts[], n int, v public.members) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_next text;
begin
  if coalesce(array_length(rows, 1), 0) > n then
    v_next := private.cursor_of(rows[n].created_at, rows[n].id);
    rows := rows[1:n];
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.post_json(r, v.id) order by r.created_at desc, r.id desc) from unnest(rows) r), '[]'::jsonb),
    'nextCursor', v_next);
end $$;

-- --------------------------------------------------------------- companies ---
-- The directory: companies we reviewed, plus any company that has members.
-- Order: mine, then the most members, then the name.
create or replace function public.list_companies(p_search text default null, p_cursor text default null,
                                                 p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.members := private.viewer('member');
  n int := private.page_limit(p_limit);
  o int := private.offset_of(p_cursor);
  q text := btrim(coalesce(p_search, ''));
  nq text := private.normalize_text(q);
  rows public.companies[];
  v_next text;
begin
  select array(
    select c from public.companies c
    left join lateral (select count(*) as mc from public.members m where m.company_id = c.id and m.status <> 'banned') k on true
    where c.status = 'active'
      and (c.listed or k.mc > 0)
      and (q = ''
           or (nq <> '' and c.search_text like private.like_pattern(nq))
           or c.domain like private.like_pattern(lower(q)))
    order by (c.id = v.company_id) desc nulls last, k.mc desc, c.listed desc, c.name, c.id
    offset o limit n + 1) into rows;
  if coalesce(array_length(rows, 1), 0) > n then
    v_next := (o + n)::text;
    rows := rows[1:n];
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.company_json(r, v) order by i)
                       from generate_subscripts(rows, 1) i, lateral (select rows[i] as r) x), '[]'::jsonb),
    'nextCursor', v_next);
end $$;

-- The public page of a company: who it is and two counts. Its posts stay behind
-- list_posts('company'), which only answers for its own verified members.
create or replace function public.get_company(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.members := private.viewer('member'); c public.companies;
begin
  select * into c from public.companies where id = p_id and status = 'active';
  if c.id is null then perform private.fail('not-found'); end if;
  return private.company_json(c, v);
end $$;

drop function public.mod_update_company(uuid, text, text, text);
create or replace function public.mod_update_company(p_company_id uuid, p_name text default null,
    p_sector text default null, p_status text default null, p_name_en text default null,
    p_listed boolean default null, p_icon_hidden boolean default null, p_refetch_icon boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.members := private.moderator();
begin
  update public.companies
     set name = coalesce(nullif(btrim(p_name), ''), name),
         name_en = coalesce(nullif(btrim(p_name_en), ''), name_en),
         sector = coalesce(nullif(btrim(p_sector), ''), sector),
         status = coalesce(p_status, status),
         listed = coalesce(p_listed, listed),
         icon_hidden = coalesce(p_icon_hidden, icon_hidden),
         icon_checked_at = case when coalesce(p_refetch_icon, false) then null else icon_checked_at end
   where id = p_company_id;
  if not found then perform private.fail('not-found'); end if;
  insert into public.moderation_actions (moderator_id, action, target_type, target_id, note)
  values (v.id, 'company-update', 'user', p_company_id,
          concat_ws(' / ', p_name, p_name_en, p_sector, p_status,
                    case when p_listed is not null then 'listed=' || p_listed end,
                    case when p_icon_hidden is not null then 'icon_hidden=' || p_icon_hidden end,
                    case when coalesce(p_refetch_icon, false) then 'refetch-icon' end));
end $$;

create or replace function public.mod_list_companies() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.members := private.moderator();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'domain', c.domain, 'name', c.name,
      'nameEn', c.name_en, 'sector', c.sector, 'status', c.status, 'listed', c.listed,
      'iconUrl', c.icon_url, 'iconHidden', c.icon_hidden, 'iconSource', c.icon_source,
      'members', (select count(*) from public.members m where m.company_id = c.id))
      order by (not c.listed) desc, c.created_at desc, c.name)
    from public.companies c), '[]'::jsonb);
end $$;

-- Icon upkeep, called only by the "company-icons" edge function (service role).
-- fetch: reviewed companies never checked, or checked more than 60 days ago.
-- purge: hidden companies whose stored copy still exists.
create or replace function public.svc_icon_batch(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'fetch', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'domain', x.domain))
              from (select c.id, c.domain from public.companies c
                    where c.listed and c.status = 'active' and not c.icon_hidden
                      and (c.icon_checked_at is null or c.icon_checked_at < now() - interval '60 days')
                    order by c.icon_checked_at nulls first, c.created_at
                    limit least(greatest(coalesce(p_limit, 20), 1), 50)) x), '[]'::jsonb),
    'purge', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'iconUrl', c.icon_url))
              from public.companies c where c.icon_hidden and c.icon_url is not null), '[]'::jsonb))
$$;

-- p_icon_url null = nothing usable was found (or the copy was purged)
create or replace function public.svc_icon_set(p_company_id uuid, p_icon_url text, p_source text default null) returns void
language sql security definer set search_path = '' as $$
  update public.companies
     set icon_url = p_icon_url, icon_source = case when p_icon_url is null then null else p_source end,
         icon_checked_at = now()
   where id = p_company_id
$$;

create or replace function public.svc_is_moderator(p_member uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where id = p_member and role = 'moderator' and status = 'active')
$$;

-- ------------------------------------------------------------------- posts ---
create or replace function public.list_posts(p_channel text, p_cursor text default null, p_limit int default 20)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.members := private.viewer('member');
  n int := private.page_limit(p_limit);
  c_ts timestamptz; c_id uuid;
  rows public.posts[];
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
      and p.kind = 'post'          -- the question of the week has its own card
      and private.can_see_post(p, v)
      and (c_ts is null or (p.created_at, p.id) < (c_ts, c_id))
    order by p.created_at desc, p.id desc
    limit n + 1) into rows;
  return private.posts_page(rows, n, v);
end $$;

-- Search the text of posts I am allowed to see. Fewer than 2 letters: nothing.
create or replace function public.search_posts(p_query text, p_cursor text default null, p_limit int default 20)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.members := private.viewer('member');
  n int := private.page_limit(p_limit);
  nq text := private.normalize_text(left(coalesce(p_query, ''), 80));
  c_ts timestamptz; c_id uuid;
  rows public.posts[];
begin
  if char_length(nq) < 2 then return jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null); end if;
  if p_cursor is not null then
    begin
      c_ts := split_part(p_cursor, '|', 1)::timestamptz; c_id := split_part(p_cursor, '|', 2)::uuid;
    exception when others then perform private.fail('not-found'); end;
  end if;
  select array(
    select p from public.posts p
    where p.kind = 'post'
      and p.status = 'published'
      and p.search_text like private.like_pattern(nq)
      and private.can_see_post(p, v)
      and (c_ts is null or (p.created_at, p.id) < (c_ts, c_id))
    order by p.created_at desc, p.id desc
    limit n + 1) into rows;
  return private.posts_page(rows, n, v);
end $$;

-- p_poll: {"options": ["...", "..."]}  two to four choices, each 1 to 60 characters. The body is the question.
drop function public.create_post(text, text);
create or replace function public.create_post(p_channel text, p_body text, p_poll jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.members := private.viewer('post');
  v_body text := btrim(coalesce(p_body, ''), E' \n\r\t');
  v_opts text[];
  v_first text;
  p public.posts;
begin
  if not exists (select 1 from public.channels where id = p_channel) then perform private.fail('not-found'); end if;
  if v.company_id is not null and private.verified_until(v) <= now() then perform private.fail('not-verified'); end if;
  if p_channel = 'company' and v.company_id is null then perform private.fail('not-verified'); end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then perform private.fail('filtered'); end if;

  if p_poll is not null and p_poll <> 'null'::jsonb then
    if jsonb_typeof(p_poll -> 'options') is distinct from 'array' then perform private.fail('filtered'); end if;
    select array_agg(btrim(regexp_replace(e.val, '\s+', ' ', 'g')) order by e.ord) into v_opts
      from jsonb_array_elements_text(p_poll -> 'options') with ordinality as e(val, ord);
    if coalesce(array_length(v_opts, 1), 0) not between 2 and 4
       or exists (select 1 from unnest(v_opts) o where char_length(o) not between 1 and 60)
       or (select count(distinct lower(o)) from unnest(v_opts) o) <> array_length(v_opts, 1) then
      perform private.fail('filtered');
    end if;
  end if;

  if (select count(*) from public.posts where author_id = v.id and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.posts where author_id = v.id and created_at > now() - interval '1 day') >= 20
     or exists (select 1 from public.posts where author_id = v.id and body = v_body and created_at > now() - interval '10 minutes') then
    perform private.fail('rate-limited');
  end if;

  -- the choices are read by the same filter as the question
  v_first := private.first_status(v_body || coalesce(E'\n' || array_to_string(v_opts, E'\n'), ''));
  insert into public.posts (channel, author_id, company_id, body, status)
  values (p_channel, v.id, v.company_id, v_body, split_part(v_first, ':', 1))
  returning * into p;
  if v_opts is not null then
    insert into public.poll_options (post_id, sort, body)
    select p.id, i, v_opts[i] from generate_subscripts(v_opts, 1) i;
  end if;

  if p.status = 'published' then
    perform private.mark_published('post', p.id);
  elsif p.status = 'held' then
    perform private.enqueue('post', p.id, v.id, 'filter', split_part(v_first, ':', 2));
  end if;
  select * into p from public.posts where id = p.id;
  return private.post_json(p, v.id);
end $$;

create or replace function public.vote_poll(p_post_id uuid, p_option_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.members := private.viewer('write'); p public.posts;
begin
  p := private.visible_post(p_post_id, v);
  if p.status <> 'published'
     or not exists (select 1 from public.poll_options where id = p_option_id and post_id = p.id) then
    perform private.fail('not-found');
  end if;
  insert into public.poll_votes (post_id, member_id, option_id) values (p.id, v.id, p_option_id)
  on conflict (post_id, member_id) do nothing;
  if not found then perform private.fail('forbidden'); end if;   -- one vote, no change
  return private.post_json(p, v.id);
end $$;

-- the AI reads the choices together with the question
create or replace function public.svc_moderation_fetch(p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_type = 'post' then
    return (select jsonb_build_object('status', p.status, 'authorId', p.author_id,
              'body', p.body || coalesce((select E'\n\nخيارات التصويت:\n' || string_agg('- ' || o.body, E'\n' order by o.sort)
                                          from public.poll_options o where o.post_id = p.id), ''),
              'channel', p.channel, 'context', null)
            from public.posts p where p.id = p_id);
  elsif p_type = 'comment' then
    return (select jsonb_build_object('status', c.status, 'authorId', c.author_id, 'body', c.body,
                                      'channel', p.channel, 'context', left(p.body, 600))
            from public.comments c join public.posts p on p.id = c.post_id where c.id = p_id);
  end if;
  return null;
end $$;

-- ------------------------------------------------------------------- saved ---
create or replace function public.set_saved(p_post_id uuid, p_saved boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.members := private.viewer('member'); p public.posts;
begin
  if coalesce(p_saved, false) then
    p := private.visible_post(p_post_id, v);
    if (select count(*) from public.saved_posts where member_id = v.id) >= 500 then perform private.fail('rate-limited'); end if;
    insert into public.saved_posts (member_id, post_id) values (v.id, p.id) on conflict do nothing;
  else
    delete from public.saved_posts where member_id = v.id and post_id = p_post_id;
  end if;
end $$;

-- most recently saved first; a post I can no longer see (removed, blocked author, left the company) drops out
create or replace function public.list_saved_posts(p_cursor text default null, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.members := private.viewer('member');
  n int := private.page_limit(p_limit);
  c_ts timestamptz; c_id uuid;
  ids uuid[]; tss timestamptz[];
  v_next text;
begin
  if p_cursor is not null then
    begin
      c_ts := split_part(p_cursor, '|', 1)::timestamptz; c_id := split_part(p_cursor, '|', 2)::uuid;
    exception when others then perform private.fail('not-found'); end;
  end if;
  select array_agg(t.post_id order by t.created_at desc, t.post_id desc),
         array_agg(t.created_at order by t.created_at desc, t.post_id desc)
    into ids, tss
  from (select s.post_id, s.created_at from public.saved_posts s join public.posts p on p.id = s.post_id
        where s.member_id = v.id and private.can_see_post(p, v)
          and (c_ts is null or (s.created_at, s.post_id) < (c_ts, c_id))
        order by s.created_at desc, s.post_id desc limit n + 1) t;
  if coalesce(array_length(ids, 1), 0) > n then
    v_next := private.cursor_of(tss[n], ids[n]);
    ids := ids[1:n];
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.post_json(p, v.id) order by i)
                       from generate_subscripts(ids, 1) i join public.posts p on p.id = ids[i]), '[]'::jsonb),
    'nextCursor', v_next);
end $$;

-- --------------------------------------------------- the question of the week ---
create or replace function private.week_start(p_at timestamptz default now()) returns timestamptz
language sql stable set search_path = '' as $$
  -- weeks turn on Sunday 00:00 in Riyadh
  select (date_trunc('week', (p_at at time zone 'Asia/Riyadh') + interval '1 day') - interval '1 day') at time zone 'Asia/Riyadh'
$$;

-- This week's question, creating its post the first time anyone asks.
create or replace function private.ensure_weekly() returns public.weekly_questions
language plpgsql set search_path = '' as $$
declare
  w timestamptz := private.week_start();
  q public.weekly_questions;
  v_post uuid;
begin
  select * into q from public.weekly_questions where starts_at = w;
  if q.id is not null then return q; end if;
  perform pg_advisory_xact_lock(hashtext('wrk.weekly'));
  select * into q from public.weekly_questions where starts_at = w;
  if q.id is not null then return q; end if;

  select * into q from public.weekly_questions where starts_at is null order by sort, created_at, id limit 1;
  if q.id is null then
    -- the bank is used up: the oldest question comes round again
    insert into public.weekly_questions (body, sort)
    select body, sort from public.weekly_questions order by starts_at, id limit 1
    returning * into q;
    if q.id is null then return null; end if;
  end if;
  insert into public.posts (channel, author_id, company_id, body, status, published_at, kind)
  values ('all', null, null, q.body, 'published', now(), 'weekly') returning id into v_post;
  update public.weekly_questions set starts_at = w, post_id = v_post where id = q.id returning * into q;
  return q;
end $$;

create or replace function public.get_weekly_question() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.members := private.viewer('member'); q public.weekly_questions;
begin
  q := private.ensure_weekly();
  if q.id is null or q.post_id is null
     or not exists (select 1 from public.posts where id = q.post_id and status = 'published') then
    return null;
  end if;
  return jsonb_build_object(
    'id', q.id, 'postId', q.post_id, 'text', q.body,
    'endsAt', private.ts(q.starts_at + interval '7 days'),
    'answerCount', (select count(*) from public.comments c where c.post_id = q.post_id and c.status = 'published'
                      and not private.is_blocked(v.id, c.author_id)));
end $$;

-- A moderator adds a question; it runs next week (p_first) or after the rest of the bank.
create or replace function public.mod_add_weekly_question(p_text text, p_first boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.members := private.moderator(); v_body text := btrim(coalesce(p_text, '')); q public.weekly_questions;
begin
  if char_length(v_body) not between 5 and 200 then perform private.fail('filtered'); end if;
  insert into public.weekly_questions (body, sort)
  values (v_body, case when coalesce(p_first, true)
                       then coalesce((select min(sort) from public.weekly_questions where starts_at is null), 0) - 1
                       else coalesce((select max(sort) from public.weekly_questions), 0) + 1 end)
  returning * into q;
  insert into public.moderation_actions (moderator_id, action, target_type, target_id, note)
  values (v.id, 'weekly-question', 'post', q.id, left(v_body, 200));
  return jsonb_build_object('id', q.id, 'text', q.body);
end $$;

create or replace function public.mod_list_weekly_questions() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.members := private.moderator();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'text', q.body,
        'startsAt', private.ts(q.starts_at), 'postId', q.post_id) order by q.starts_at desc nulls first, q.sort, q.created_at)
      from public.weekly_questions q), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------- notifications ---
-- A like tells the author once per post: the unread row is re-used and carries the running total.
create or replace function public.set_like(p_post_id uuid, p_liked boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.members := private.viewer('write'); p public.posts; v_new boolean := false; v_total int;
begin
  p := private.visible_post(p_post_id, v);
  if p.status <> 'published' then perform private.fail('not-found'); end if;
  if p_liked then
    insert into public.post_likes (post_id, member_id) values (p.id, v.id) on conflict do nothing;
    v_new := found;
  else
    delete from public.post_likes where post_id = p.id and member_id = v.id;
  end if;
  select count(*) into v_total from public.post_likes where post_id = p.id;
  if v_new and p.author_id is not null and p.author_id <> v.id and not private.is_blocked(p.author_id, v.id) then
    update public.notifications set count = v_total, created_at = now()
     where member_id = p.author_id and type = 'like' and post_id = p.id and read_at is null;
    if not found then
      insert into public.notifications (member_id, type, post_id, count) values (p.author_id, 'like', p.id, v_total);
    end if;
  end if;
  return jsonb_build_object('likeCount', v_total, 'likedByMe', coalesce(p_liked, false));
end $$;

-- someone came in with one of my invitations
create or replace function private.notify_invite_used() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.owner_id is not null and old.used_at is null and new.used_at is not null then
    insert into public.notifications (member_id, type) values (new.owner_id, 'invite-joined');
  end if;
  return new;
end $$;
create trigger invites_notify_used after update of used_at on public.invites
  for each row execute function private.notify_invite_used();

create or replace function public.list_notifications(p_cursor text default null, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.members := private.viewer('member');
  n int := private.page_limit(p_limit);
  c_ts timestamptz; c_id uuid;
  rows public.notifications[];
  v_next text;
begin
  if p_cursor is not null then
    begin
      c_ts := split_part(p_cursor, '|', 1)::timestamptz; c_id := split_part(p_cursor, '|', 2)::uuid;
    exception when others then perform private.fail('not-found'); end;
  end if;
  select array(
    select x from public.notifications x
    where x.member_id = v.id and (c_ts is null or (x.created_at, x.id) < (c_ts, c_id))
    order by x.created_at desc, x.id desc limit n + 1) into rows;
  if coalesce(array_length(rows, 1), 0) > n then
    v_next := private.cursor_of(rows[n].created_at, rows[n].id);
    rows := rows[1:n];
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'type', r.type, 'postId', r.post_id, 'commentId', r.comment_id,
        'createdAt', private.ts(r.created_at), 'read', r.read_at is not null,
        'count', r.count,
        -- a few words of MY OWN post, so the row says which one it is about
        'excerpt', (select left(regexp_replace(p.body, '\s+', ' ', 'g'), 80) from public.posts p
                    where p.id = r.post_id and p.author_id = v.id))
        order by r.created_at desc, r.id desc) from unnest(rows) r), '[]'::jsonb),
    'nextCursor', v_next);
end $$;

-- ------------------------------------------------------------------ privacy ---
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
    'posts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'channel', p.channel, 'body', p.body,
                'pollOptions', (select jsonb_agg(o.body order by o.sort) from public.poll_options o where o.post_id = p.id),
                'status', p.status, 'createdAt', private.ts(p.created_at)) order by p.created_at)
              from public.posts p where p.author_id = v.id), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'postId', post_id, 'body', body,
                'status', status, 'createdAt', private.ts(created_at)) order by created_at)
              from public.comments where author_id = v.id), '[]'::jsonb),
    'likes', coalesce((select jsonb_agg(jsonb_build_object('postId', post_id, 'createdAt', private.ts(created_at)))
              from public.post_likes where member_id = v.id), '[]'::jsonb),
    'saved', coalesce((select jsonb_agg(jsonb_build_object('postId', post_id, 'createdAt', private.ts(created_at)))
              from public.saved_posts where member_id = v.id), '[]'::jsonb),
    'pollVotes', coalesce((select jsonb_agg(jsonb_build_object('postId', pv.post_id, 'choice', o.body, 'createdAt', private.ts(pv.created_at)))
              from public.poll_votes pv join public.poll_options o on o.id = pv.option_id where pv.member_id = v.id), '[]'::jsonb),
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

-- ------------------------------------------------------------------ grants ---
do $$
declare
  f record;
  app     text[] := array['list_companies','get_company','search_posts','create_post','vote_poll','set_saved',
                          'list_saved_posts','get_weekly_question','mod_update_company','mod_add_weekly_question',
                          'mod_list_weekly_questions'];
  service text[] := array['svc_icon_batch','svc_icon_set','svc_is_moderator'];
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
