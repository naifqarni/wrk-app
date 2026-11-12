// Round 3: company directory and icons, polls, the question of the week, saved
// posts, search. Same stack as e2e.test.ts, on its own database so the two
// files can run side by side.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CRON, DB_URL, World } from './harness.ts';
import { iconCandidates, manifestIcons, sniffImage } from '../supabase/functions/_shared/logic.ts';

const appDir = process.env.WRK_APP_DIR ?? path.resolve(import.meta.dirname, '../../wrk-app');
const { createSupabaseCommunityApi } = await import(pathToFileURL(path.join(appDir, 'src/community/api/supabase.ts')).href);
type Api = ReturnType<typeof createSupabaseCommunityApi>;

const w = new World(process.env.TEST_DATABASE_URL_R3 ?? DB_URL.replace(/\/[^/]+$/, '/wrk_test_r3'));
const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e: any) { return e.code ?? `threw:${e.message}`; } };
let house: string[] = [];

async function join(email: string): Promise<{ api: Api; raw: ReturnType<World['client']>; me: any }> {
  const raw = w.client();
  const api = createSupabaseCommunityApi(raw as any);
  await api.requestEmailCode(email, { kind: 'invite', code: house.pop()! });
  await api.verifyEmailCode(email, w.outbox.get(email)!);
  const me = await api.acceptRules();
  return { api, raw, me };
}
async function seedPost(authorId: string, channel: string, body: string, minutesAgo = 0): Promise<string> {
  return (await w.sql(
    `insert into public.posts (channel, author_id, company_id, body, status, published_at, created_at)
     select $2, m.id, m.company_id, $3, 'published', now(), now() - make_interval(mins => $4) from public.members m where m.id = $1 returning id`,
    [authorId, channel, body, minutesAgo]))[0].id;
}
const png = (n = 400) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
const icons = (who: { raw: any } | null, body: object = {}, cron = false) =>
  ((who?.raw ?? w.client()) as any).functions.invoke('company-icons', { body, headers: cron ? { 'x-cron-secret': CRON } : {} });

let A: Awaited<ReturnType<typeof join>>, B: typeof A, C: typeof A, D: typeof A, MOD: typeof A;
const guest = () => createSupabaseCommunityApi(w.client() as any);

before(async () => {
  house = (await w.sql(`select private.mint_invites(null, 20, 'tests') as code`)).map((r: any) => r.code);
  A = await join('a@aramco.com');
  B = await join('b@aramco.com');
  C = await join('c@stc.com.sa');
  D = await join('d@tinystudio.sa');
  MOD = await join('mod@elm.sa');
  await w.sql(`update public.members set role = 'moderator' where id = $1`, [MOD.me.id]);
});
after(() => w.close());

test('directory: the large Saudi employers are there, searchable, paged, mine first', async () => {
  const seeded = await w.sql(`select count(*)::int n, count(*) filter (where name_en is null or sector is null or name = domain)::int bad
                              from public.companies where listed`);
  assert.ok(seeded[0].n >= 150, `only ${seeded[0].n} companies`);
  assert.equal(seeded[0].bad, 0, 'every reviewed company has both names and a sector');
  assert.equal((await w.sql(`select count(*)::int n from public.companies c join public.blocked_email_domains b on b.domain = c.domain`))[0].n, 0);

  assert.equal(await code(() => guest().listCompanies!()), 'not-verified', 'members only');
  assert.equal(await code(() => guest().getCompany!(A.me.companyId)), 'not-verified');

  const first = await A.api.listCompanies!({ limit: 50 });
  assert.equal(first.items.length, 50);
  assert.equal(first.items[0].name, 'أرامكو السعودية');
  assert.deepEqual([first.items[0].mine, first.items[0].memberCount, first.items[0].nameEn, first.items[0].domain, first.items[0].sector],
    [true, 2, 'Saudi Aramco', 'aramco.com', 'الطاقة']);
  assert.ok(first.items.slice(1).every((c: any) => !c.mine));
  // then the companies that already have members, before the empty ones
  assert.deepEqual(first.items.slice(1, 4).map((c: any) => c.memberCount), [1, 1, 1]);
  assert.equal((await C.api.listCompanies!({ limit: 1 })).items[0].name, 'stc');

  const seen = new Set<string>();
  let cursor: string | null = null, pages = 0;
  do {
    const p: any = await A.api.listCompanies!({ limit: 40, cursor });
    for (const c of p.items) { assert.ok(!seen.has(c.id), 'no company twice'); seen.add(c.id); }
    cursor = p.nextCursor; pages++;
  } while (cursor && pages < 20);
  assert.equal(seen.size, seeded[0].n + 1, 'all reviewed companies plus the unreviewed one that has a member');
  assert.equal(await code(() => A.api.listCompanies!({ cursor: 'x' })), 'not-found');

  const names = async (search: string) => (await A.api.listCompanies!({ search })).items.map((c: any) => c.nameEn ?? c.name);
  assert.deepEqual(await names('ارامكو'), ['Saudi Aramco'], 'hamza or no hamza');
  assert.deepEqual(await names('ARAMCO'), ['Saudi Aramco']);
  assert.deepEqual(await names('riyad bank'), ['Riyad Bank']);
  assert.ok((await names('stc')).includes('stc'));
  assert.ok((await names('البنوك')).length >= 10, 'the sector label matches');
  assert.deepEqual(await names('tinystudio'), ['tinystudio.sa'], 'an employer nobody reviewed shows once it has a member');
  assert.deepEqual(await names('%'), []);
  assert.deepEqual(await names('لا توجد شركة بهذا الاسم'), []);
});

test('company space: its own members read it, everyone else gets two counts', async () => {
  await A.api.createPost({ channel: 'company', body: 'تذكير: اجتماع الفريق انتقل للأحد.' });
  await seedPost(B.me.id, 'company', 'من جرب المكاتب الجديدة في الدور الثالث؟');
  await seedPost(A.me.id, 'all', 'منشور عام لا يحسب على مساحة الشركة.');

  const mine = await B.api.getCompany!(A.me.companyId);
  assert.deepEqual([mine.mine, mine.memberCount, mine.postCount], [true, 2, 2]);
  assert.equal((await B.api.listPosts({ channel: 'company' })).items.length, 2);

  const outside = await C.api.getCompany!(A.me.companyId);
  assert.deepEqual([outside.mine, outside.memberCount, outside.postCount], [false, 2, 2]);
  assert.deepEqual(Object.keys(outside).sort(), ['domain', 'iconUrl', 'id', 'memberCount', 'mine', 'name', 'nameEn', 'postCount', 'sector'], 'nothing else leaks');
  const theirs = (await C.api.listPosts({ channel: 'company' })).items;
  assert.equal(theirs.length, 0, 'an outsider asking for the company channel only ever gets their own company');
  assert.ok(!(await C.api.listPosts({ channel: 'all' })).items.some((p: any) => p.channel === 'company'));

  assert.equal(await code(() => A.api.getCompany!('00000000-0000-4000-8000-000000000000')), 'not-found');
  assert.equal(await code(() => A.api.getCompany!('nonsense')), 'not-found');
  await w.sql(`update public.companies set status = 'blocked' where domain = 'tinystudio.sa'`);
  assert.equal(await code(() => A.api.getCompany!(D.me.companyId)), 'not-found');
  assert.deepEqual((await A.api.listCompanies!({ search: 'tinystudio' })).items, []);
  await w.sql(`update public.companies set status = 'active' where domain = 'tinystudio.sa'`);
});

test('icon parsing: touch icon first, no SVG, no ICO, nothing off https', () => {
  const html = `<html><head>
    <link rel="icon" href="/favicon.ico">
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="icon" type="image/png" sizes="32x32" href="/f32.png">
    <link rel="icon" type="image/png" sizes="192x192" href="/f192.png">
    <link rel='apple-touch-icon' sizes='180x180' href='//cdn.example.sa/touch.png?v=1&amp;x=2'>
    <link rel="icon" href="http://example.sa/plain-http.png" sizes="512x512">
    <link rel="icon" href="https://10.0.0.5/internal.png" sizes="512x512">
    <link rel="manifest" href="/site.webmanifest">
    <link rel="stylesheet" href="/a.css"></head></html>`;
  const out = iconCandidates(html, 'https://www.example.sa/');
  assert.deepEqual(out.icons.map((i) => i.url), ['https://cdn.example.sa/touch.png?v=1&x=2', 'https://www.example.sa/f192.png']);
  assert.equal(out.manifest, 'https://www.example.sa/site.webmanifest');
  const m = manifestIcons({ icons: [{ src: 'i512.png', sizes: '512x512' }, { src: '/i192.png', sizes: '192x192' }, { src: 'mono.png', sizes: '192x192', purpose: 'monochrome' }, { src: 'v.svg', sizes: 'any' }] },
    'https://www.example.sa/assets/site.webmanifest');
  assert.deepEqual(m.map((i) => i.url), ['https://www.example.sa/i192.png', 'https://www.example.sa/assets/i512.png']);
  assert.deepEqual(sniffImage(png()), { contentType: 'image/png', ext: 'png' });
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">' + ' '.repeat(200) + '</svg>')), null);
  assert.equal(sniffImage(png(600 * 1024)), null, 'too big');
  assert.equal(sniffImage(new Uint8Array(400)), null);
});

test('icons: copied into our storage untouched, only for reviewed companies, taken down on request', async () => {
  const touch = png(900);
  w.site.set('https://www.aramco.com/', { body: `<head><link rel="apple-touch-icon" href="/t.png"><link rel="icon" href="/favicon.ico"></head>` });
  w.site.set('https://www.aramco.com/t.png', { body: touch });
  // stc: the page declares only an SVG, but the well-known touch icon path answers
  w.site.set('https://www.stc.com.sa/', { body: `<head><link rel="icon" type="image/svg+xml" href="/logo.svg"></head>`, finalUrl: 'https://www.stc.com.sa/content/stc/sa/ar/personal/home.html' });
  w.site.set('https://www.stc.com.sa/apple-touch-icon.png', { body: png(500) });
  // elm: says PNG, serves an SVG document
  w.site.set('https://www.elm.sa/', { body: `<head><link rel="apple-touch-icon" href="/fake.png"></head>` });
  w.site.set('https://www.elm.sa/fake.png', { body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' + ' '.repeat(200) + '</svg>' });
  w.site.set('https://www.tinystudio.sa/', { body: `<head><link rel="apple-touch-icon" href="/t.png"></head>` });
  w.site.set('https://www.tinystudio.sa/t.png', { body: png() });

  assert.equal((await (await icons(null)).error.context.json()).error, 'not-verified');
  assert.equal((await (await icons(A)).error.context.json()).error, 'forbidden', 'members cannot make the server fetch things');

  // only look at the companies this test knows; the rest of the directory stays unchecked
  await w.sql(`update public.companies set icon_checked_at = now() where domain not in ('aramco.com','stc.com.sa','elm.sa','tinystudio.sa')`);
  const run = await icons(MOD, { limit: 30 });
  assert.deepEqual([run.data.saved, run.data.none, run.data.purged], [2, 1, 0]);
  assert.ok(!w.fetched.some((u) => u.includes('tinystudio')), 'an unreviewed domain is never fetched');
  assert.ok(w.fetched.every((u) => u.startsWith('https://')));

  const aramco = await C.api.getCompany!(A.me.companyId);
  assert.equal(aramco.iconUrl, `https://backend.test/storage/v1/object/public/company-icons/${A.me.companyId}.png`);
  assert.deepEqual(w.bucket.get(`${A.me.companyId}.png`), touch, 'byte for byte');
  assert.ok((await C.api.getCompany!(C.me.companyId)).iconUrl);
  assert.equal((await C.api.getCompany!(MOD.me.companyId)).iconUrl, null, 'no usable icon: the app draws the monogram');
  assert.equal((await C.api.getCompany!(D.me.companyId)).iconUrl, null);
  assert.equal((await w.sql(`select icon_source from public.companies where domain = 'aramco.com'`))[0].icon_source, 'https://www.aramco.com/t.png');

  // the icon rides along with the author while they show their employer
  const postId = await seedPost(A.me.id, 'culture', 'الأيقونة تظهر بجانب اسم الشركة.');
  let author = (await C.api.getPost(postId)).author;
  assert.deepEqual([author.companyLabel, author.companyId, author.companyIconUrl], ['أرامكو السعودية', A.me.companyId, aramco.iconUrl]);
  await A.api.updateMe({ showCompany: false });
  author = (await C.api.getPost(postId)).author;
  assert.deepEqual([author.companyLabel, author.companyId, author.companyIconUrl], ['الطاقة', null, null], 'hiding the employer hides its id and icon too');
  await A.api.updateMe({ showCompany: true });

  const again = await icons(null, {}, true);
  assert.deepEqual([again.data.saved, again.data.none], [0, 0], 'checked companies are left alone for 60 days');

  // takedown: hidden at once for everyone, and our copy is deleted on the next run
  assert.equal(await code(async () => { const r = await A.raw.rpc('mod_update_company', { p_company_id: A.me.companyId, p_icon_hidden: true }); if (r.error) throw Object.assign(new Error(), { code: r.error.message }); }), 'forbidden');
  await MOD.raw.rpc('mod_update_company', { p_company_id: A.me.companyId, p_icon_hidden: true });
  assert.equal((await C.api.getCompany!(A.me.companyId)).iconUrl, null);
  assert.equal((await C.api.getPost(postId)).author.companyIconUrl, null);
  const purge = await icons(null, {}, true);
  assert.equal(purge.data.purged, 1);
  assert.equal(w.bucket.has(`${A.me.companyId}.png`), false);
  assert.equal((await w.sql(`select icon_url from public.companies where domain = 'aramco.com'`))[0].icon_url, null);
  await w.sql(`update public.companies set icon_checked_at = null where domain = 'aramco.com'`);
  assert.equal((await icons(null, {}, true)).data.saved, 0, 'a hidden icon is never fetched again');
});

test('polls: one vote each, never changed, nobody sees who chose what', async () => {
  const p = await A.api.createPost({ channel: 'culture', body: 'الدوام المرن: مع أو ضد؟', poll: { options: ['  مع  ', 'ضد', 'حسب الفريق'] } });
  assert.equal(p.status, 'published');
  assert.deepEqual(p.poll!.options.map((o: any) => [o.text, o.votes]), [['مع', 0], ['ضد', 0], ['حسب الفريق', 0]]);
  assert.deepEqual([p.poll!.totalVotes, p.poll!.myOptionId], [0, null]);
  const [yes, no] = p.poll!.options.map((o: any) => o.id);

  const afterB = await B.api.votePoll!(p.id, yes);
  assert.deepEqual([afterB.poll!.totalVotes, afterB.poll!.myOptionId, afterB.poll!.options[0].votes], [1, yes, 1]);
  assert.equal(await code(() => B.api.votePoll!(p.id, no)), 'forbidden', 'no changing your mind');
  await C.api.votePoll!(p.id, no);
  await A.api.votePoll!(p.id, yes);
  const seenByD = (await D.api.listPosts({ channel: 'culture' })).items.find((x: any) => x.id === p.id)!;
  assert.deepEqual(seenByD.poll!.options.map((o: any) => o.votes), [2, 1, 0]);
  assert.deepEqual([seenByD.poll!.totalVotes, seenByD.poll!.myOptionId], [3, null]);
  assert.ok(!JSON.stringify(seenByD).includes(B.me.id), 'voters are not in the payload');

  const other = await C.api.createPost({ channel: 'all', body: 'قهوة الصباح؟', poll: { options: ['سوداء', 'بحليب'] } });
  assert.equal(await code(() => A.api.votePoll!(p.id, other.poll!.options[0].id)), 'not-found', 'an option of another poll');
  assert.equal(await code(() => guest().votePoll!(p.id, yes)), 'not-verified');
  assert.equal((await A.api.getPost((await A.api.listPosts({ channel: 'all' })).items.find((x: any) => !x.poll)!.id)).poll, null);

  // a poll in a company space is as walled as the space
  const inside = await B.api.createPost({ channel: 'company', body: 'وين نسوي لقاء الفريق؟', poll: { options: ['المكتب', 'برا'] } });
  assert.equal(await code(() => C.api.votePoll!(inside.id, inside.poll!.options[0].id)), 'not-found');

  for (const options of [['وحيد'], ['١', '٢', '٣', '٤', '٥'], ['نفسه', 'نفسه'], ['', 'ب'], ['x'.repeat(61), 'ب']]) {
    assert.equal(await code(() => D.api.createPost({ channel: 'all', body: 'سؤال؟', poll: { options } })), 'filtered', JSON.stringify(options));
  }
  // the choices are filtered like any text
  assert.equal(await code(() => D.api.createPost({ channel: 'all', body: 'كيف تتواصلون؟', poll: { options: ['اتصل 0551234567', 'إيميل'] } })), 'filtered');
  const held = await D.api.createPost({ channel: 'all', body: 'وين تقرون الأخبار؟', poll: { options: ['https://example.com/news', 'ما أقرأ'] } });
  assert.equal(held.status, 'pending', 'a link in a choice waits for a moderator like a link in a post');
  assert.equal(await code(() => A.api.votePoll!(held.id, held.poll!.options[0].id)), 'not-found');

  const mine: any = await B.api.exportMyData!();
  assert.deepEqual(mine.pollVotes.map((v: any) => v.choice), ['مع']);
  assert.deepEqual(mine.posts.find((x: any) => x.id === inside.id).pollOptions, ['المكتب', 'برا']);
  const fed = await w.service('svc_moderation_fetch', { p_type: 'post', p_id: p.id });
  assert.ok(fed.body.includes('حسب الفريق'), 'the AI reads the choices with the question');
});

test('question of the week: one prompt for everyone, answered in its comments', async () => {
  assert.equal(await code(() => guest().getWeeklyQuestion!()), 'not-verified');
  const q = (await A.api.getWeeklyQuestion!())!;
  assert.equal(q.text, 'وش أول شي تسويه إذا وصلت المكتب؟');
  assert.equal(q.answerCount, 0);
  const ends = new Date(q.endsAt);
  assert.ok(ends.getTime() > Date.now() && ends.getTime() - Date.now() <= 7 * 864e5);
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Riyadh', weekday: 'short', hour: '2-digit', hour12: false }).format(ends).replace(/\s+/g, ' '), 'Sun, 00');
  assert.deepEqual(await B.api.getWeeklyQuestion!(), q, 'the same one for everybody, made once');
  assert.equal((await w.sql(`select count(*)::int n from public.posts where kind = 'weekly'`))[0].n, 1);

  const post = await C.api.getPost(q.postId);
  assert.deepEqual(post.author, { id: 'wrk', handle: 'wrk.', companyLabel: null });
  assert.deepEqual([post.body, post.channel, post.mine, post.status], [q.text, 'all', false, 'published']);
  for (const ch of ['all', 'culture'] as const) {
    assert.ok(!(await A.api.listPosts({ channel: ch })).items.some((p: any) => p.id === q.postId), 'it has its own card, not a place in the feed');
  }
  assert.deepEqual((await A.api.searchPosts!({ query: 'المكتب' })).items.filter((p: any) => p.id === q.postId), []);

  await B.api.createComment({ postId: q.postId, body: 'قهوة، بعدين أشوف البريد.' });
  await C.api.createComment({ postId: q.postId, body: 'أسلم على الفريق أول.' });
  assert.equal((await A.api.getWeeklyQuestion!())!.answerCount, 2);
  assert.equal((await A.api.listComments({ postId: q.postId })).items.length, 2);
  assert.deepEqual(await A.api.setLike(q.postId, true), { likeCount: 1, likedByMe: true });
  await A.api.setSaved!(q.postId, true);
  assert.equal(await code(() => A.api.deletePost(q.postId)), 'forbidden');
  assert.equal(await code(() => A.api.blockUser('wrk')), 'not-found');
  assert.equal(await code(() => A.api.report({ type: 'user', id: 'wrk' }, 'spam')), 'not-found');
  assert.equal((await w.sql(`select count(*)::int n from public.notifications where post_id = $1`, [q.postId]))[0].n, 0, 'the house gets no notifications');

  // a moderator queues the next one; members cannot
  assert.equal(await code(async () => { const r = await A.raw.rpc('mod_add_weekly_question', { p_text: 'سؤال من عضو؟' }); if (r.error) throw Object.assign(new Error(), { code: r.error.message }); }), 'forbidden');
  await MOD.raw.rpc('mod_add_weekly_question', { p_text: 'وش خطتك لإجازة نهاية الأسبوع؟' });
  // a week passes
  await w.sql(`update public.weekly_questions set starts_at = starts_at - interval '7 days' where starts_at is not null`);
  const next = (await A.api.getWeeklyQuestion!())!;
  assert.equal(next.text, 'وش خطتك لإجازة نهاية الأسبوع؟');
  assert.notEqual(next.postId, q.postId);
  assert.equal(next.answerCount, 0);
  assert.equal((await A.api.getPost(q.postId)).commentCount, 2, 'last week\'s answers stay readable');

  // the bank runs dry: the oldest question comes round again as a fresh post
  await w.sql(`delete from public.weekly_questions where starts_at is null`);
  await w.sql(`update public.weekly_questions set starts_at = starts_at - interval '7 days' where starts_at is not null`);
  const recycled = (await A.api.getWeeklyQuestion!())!;
  assert.equal(recycled.text, q.text);
  assert.ok(![q.postId, next.postId].includes(recycled.postId));
  // a moderator removes this week's post: no card
  await w.sql(`update public.posts set status = 'removed' where id = $1`, [recycled.postId]);
  assert.equal(await A.api.getWeeklyQuestion!(), null);
});

test('saved posts: mine only, newest save first, gone when the post is', async () => {
  const p1 = await seedPost(B.me.id, 'advice', 'نصيحة أولى: اكتب كل شي.', 30);
  const p2 = await seedPost(C.me.id, 'advice', 'نصيحة ثانية: اسأل بدري.', 20);
  const p3 = await seedPost(B.me.id, 'company', 'داخل الشركة فقط.', 10);
  await w.sql(`delete from public.saved_posts`);
  await A.api.setSaved!(p2, true);
  await w.sql(`update public.saved_posts set created_at = created_at - interval '2 minutes'`);
  await A.api.setSaved!(p1, true);
  await w.sql(`update public.saved_posts set created_at = created_at - interval '2 minutes'`);
  await A.api.setSaved!(p3, true);
  await A.api.setSaved!(p3, true);
  assert.deepEqual((await A.api.listSavedPosts!()).items.map((p: any) => p.id), [p3, p1, p2]);
  assert.ok((await A.api.listSavedPosts!()).items.every((p: any) => p.savedByMe));
  assert.equal((await A.api.getPost(p1)).savedByMe, true);
  assert.equal((await B.api.getPost(p1)).savedByMe, false, 'saving is private');
  assert.deepEqual((await B.api.listSavedPosts!()).items, []);

  const page1 = await A.api.listSavedPosts!({ limit: 2 });
  assert.deepEqual(page1.items.map((p: any) => p.id), [p3, p1]);
  const page2 = await A.api.listSavedPosts!({ limit: 2, cursor: page1.nextCursor });
  assert.deepEqual([page2.items.map((p: any) => p.id), page2.nextCursor], [[p2], null]);

  assert.equal(await code(() => C.api.setSaved!(p3, true)), 'not-found', 'cannot save what I cannot see');
  assert.equal(await code(() => guest().setSaved!(p1, true)), 'not-verified');
  await A.api.blockUser(C.me.id);
  assert.deepEqual((await A.api.listSavedPosts!()).items.map((p: any) => p.id), [p3, p1], 'a blocked author drops out');
  await A.api.unblockUser(C.me.id);
  await A.api.setSaved!(p1, false);
  await w.sql(`delete from public.posts where id = $1`, [p3]);
  assert.deepEqual((await A.api.listSavedPosts!()).items.map((p: any) => p.id), [p2]);
  assert.deepEqual(((await A.api.exportMyData!()) as any).saved.map((s: any) => s.postId), [p2]);
});

test('search: the text of posts I may see, however the letters were typed', async () => {
  const pub = await seedPost(C.me.id, 'salaries', 'هل البدلات تدخل في حساب الإجازة السنوية؟', 5);
  const wall = await seedPost(B.me.id, 'company', 'الإجازة السنوية عندنا تتغير السنة الجاية.', 4);
  const held = await seedPost(C.me.id, 'all', 'الإجازة السنوية بانتظار المراجعة', 3);
  await w.sql(`update public.posts set status = 'held' where id = $1`, [held]);
  const ids = async (who: typeof A, query: string) => (await who.api.searchPosts!({ query })).items.map((p: any) => p.id);

  assert.deepEqual(await ids(A, 'الاجازه السنويه'), [wall, pub], 'no hamza, ha for ta marbuta: still found; newest first');
  assert.deepEqual(await ids(D, 'الإجازة السنوية'), [pub], 'another company never finds what is behind the wall');
  assert.deepEqual(await ids(C, 'الإجازة السنوية'), [pub], 'held posts are not searchable, even by their author');
  assert.deepEqual(await ids(A, 'ا'), [], 'one letter is not a search');
  assert.deepEqual(await ids(A, '%%'), []);
  assert.deepEqual(await ids(A, '__'), []);
  assert.deepEqual(await ids(A, 'كلمة لن يكتبها أحد هنا'), []);
  assert.equal(await code(() => guest().searchPosts!({ query: 'الإجازة' })), 'not-verified');
  await A.api.blockUser(C.me.id);
  assert.deepEqual(await ids(A, 'البدلات'), []);
  await A.api.unblockUser(C.me.id);

  for (let i = 0; i < 5; i++) await seedPost(C.me.id, 'all', `ملاحظة عن التدريب رقم ${i}`, 60 + i);
  const p1 = await A.api.searchPosts!({ query: 'التدريب', limit: 3 });
  const p2 = await A.api.searchPosts!({ query: 'التدريب', limit: 3, cursor: p1.nextCursor });
  assert.deepEqual([p1.items.length, p2.items.length, p2.nextCursor], [3, 2, null]);
  assert.equal(new Set([...p1.items, ...p2.items].map((p: any) => p.id)).size, 5);
});

test('round 3 tables are as closed as the rest', async () => {
  const pool = w.pool;
  for (const role of ['anon', 'authenticated']) {
    for (const t of ['public.poll_votes', 'public.poll_options', 'public.saved_posts', 'public.weekly_questions', 'public.companies']) {
      const c = await pool.connect();
      try {
        await c.query('begin'); await c.query(`set local role ${role}`);
        await assert.rejects(c.query(`select * from ${t} limit 1`), /permission denied/, `${role} reads ${t}`);
      } finally { await c.query('rollback'); c.release(); }
    }
  }
  for (const fn of ['svc_icon_batch', 'svc_icon_set', 'svc_is_moderator']) {
    const r = await (A.raw as any).rpc(fn, fn === 'svc_icon_batch' ? {} : fn === 'svc_is_moderator' ? { p_member: A.me.id } : { p_company_id: A.me.companyId, p_icon_url: 'https://evil.test/x.png' });
    assert.match(r.error?.message ?? '', /permission denied/, fn);
  }
});
