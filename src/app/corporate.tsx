/**
 * للشركات, as on corporate.wrk.sa: what we do for a team, how it goes, and the short request form.
 * The request goes to the shop (/store/wrk/lead): it lands under "طلبات الشركات" in the admin and by email.
 */
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { hasShop, links } from '@/config';
import { normalizeMobile } from '@/store/format';
import { Section } from '@/store/parts';
import { ShopError, sendLead } from '@/store/shop';
import { color, space } from '@/theme';
import { Button, Chip, Field, Num, Screen, Text, haptic } from '@/ui';

const SERVICES = [
  ['مجموعات الترحيب', 'علبة لكل موظف جديد، باسمه وبرسالة منكم، تصل قبل أول يوم.'],
  ['التصميم بهويتكم', 'شعاركم ولونكم على العلبة والقطع، بعينة قبل الإنتاج.'],
  ['البطاقات والحبال', 'بطاقات تعريف، حوامل وحبال، وبطاقات عمل للفريق.'],
  ['تجهيز المكاتب', 'لوحة الاسم، صينية المكتب والقطع اليومية، جاهزة على المكتب.'],
  ['هدايا الموظفين', 'ترقية، سنة في الشركة، رمضان والعيد. هدية باسم صاحبها.'],
  ['هدايا العملاء والشركاء', 'هدايا الزيارات والاجتماعات والعقود الجديدة.'],
  ['المناسبات والفعاليات', 'اليوم الوطني، يوم التأسيس، المؤتمرات وأيام الفريق.'],
  ['برنامج التوظيف الشهري', 'ترسلون أسماء المنضمين كل شهر، ونوصل لكل واحد مجموعته.'],
] as const;
const STEPS = [
  ['تتركون بياناتكم', 'دقيقتان في النموذج أسفل الصفحة.'],
  ['نتصل بكم', 'خلال يوم عمل، ونتفق على العدد والموعد والميزانية.'],
  ['التصميم والعينة', 'نرسل التصميم ثم عينة فعلية، ولا ننتج قبل موافقتكم.'],
  ['ننتج ونوصل', 'في الموعد، للمكتب أو لبيت كل موظف.'],
] as const;
const SIZES = ['10–49', '50–199', '200–999', '+1000'] as const;

export default function CorporateScreen() {
  const [picked, setPicked] = useState<string[]>([]);
  const [form, setForm] = useState({ name: '', company: '', phone: '', email: '', size: '', note: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const put = (k: keyof typeof form, v: string) => { setForm({ ...form, [k]: v }); if (errors[k]) setErrors(({ [k]: _gone, ...rest }) => rest); };
  const toggle = (s: string) => setPicked(picked.includes(s) ? picked.filter((x) => x !== s) : [...picked, s]);

  const send = async () => {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 2) e.name = 'اكتب اسمك.';
    if (form.company.trim().length < 2) e.company = 'اكتب اسم الشركة.';
    if (!normalizeMobile(form.phone)) e.phone = 'رقم الجوال هكذا: 05XXXXXXXX';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) e.email = 'اكتب بريد العمل.';
    setErrors(e);
    if (Object.keys(e).length) { haptic.warning(); return; }
    if (!hasShop()) { WebBrowser.openBrowserAsync(links.corporate).catch(() => {}); return; }
    setBusy(true); setFailure(null);
    try {
      const note = [picked.length ? `الخدمات: ${picked.join('، ')}` : '', `البريد: ${form.email.trim()}`, form.note.trim()].filter(Boolean).join('\n');
      await sendLead({ company: form.company.trim(), phone: normalizeMobile(form.phone)!, name: form.name.trim(), size: form.size, note });
      haptic.success();
      setSent(true);
    } catch (err) {
      haptic.error();
      setFailure(err instanceof ShopError && err.code === 'network' ? 'تعذّر الاتصال. حاول مرة أخرى.' : 'تعذّر الإرسال. حاول مرة أخرى.');
    } finally { setBusy(false); }
  };

  const footer = sent ? undefined : (
    <View style={{ gap: space[2] }}>
      {failure ? <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">{failure}</Text> : null}
      <Button label="أرسلوا الطلب" full loading={busy} haptic="tap" onPress={send} />
    </View>
  );

  return (
    <Screen edges={['left', 'right']} footer={footer} maxWidth={760}>
      <View style={{ gap: space[3], paddingTop: space[6] }}>
        <Text variant="caption" mute>للشركات</Text>
        <Text variant="display" accessibilityRole="header" style={{ fontSize: 34, lineHeight: 50 }}>{'كل ما يخص فريقكم.\nعلينا.'}</Text>
        <Text variant="body" mute>مجموعات الترحيب، هدايا الموظفين والعملاء، المناسبات، وتجهيز المكاتب. بهوية شركتكم وباسم كل موظف. نصمم وننتج ونوصل.</Text>
      </View>

      <View style={styles.facts}>
        {[['من 10 قطع', 'لفريق صغير أو لشركة كاملة'], ['عينة قبل الإنتاج', 'توافقون عليها قبل أن نبدأ'], ['لكل مدن المملكة', 'للمكتب أو لبيت كل موظف'], ['فاتورة ضريبية', 'باسم الشركة ورقمها الضريبي']].map(([a, b]) => (
          <View key={a} style={styles.fact}><Text variant="body">{a}</Text><Text variant="caption" mute>{b}</Text></View>
        ))}
      </View>

      <Section title="خدماتنا" gap={0}>
        {SERVICES.map(([t, d]) => (
          <View key={t} style={styles.row}>
            <View style={{ flex: 1, gap: 2 }}><Text variant="body">{t}</Text><Text variant="caption" mute>{d}</Text></View>
          </View>
        ))}
      </Section>

      <Section title="كيف نشتغل" gap={0}>
        {STEPS.map(([t, d], i) => (
          <View key={t} style={styles.row}>
            <Num mute style={{ width: 24 }}>{String(i + 1)}</Num>
            <View style={{ flex: 1, gap: 2 }}><Text variant="body">{t}</Text><Text variant="caption" mute>{d}</Text></View>
          </View>
        ))}
      </Section>

      {sent ? (
        <Section>
          <Text variant="display" style={{ fontSize: 28, lineHeight: 42 }}>وصلنا طلبكم.</Text>
          <Text variant="body" mute>يتصل بكم شخص من فريقنا خلال يوم عمل، من الأحد إلى الخميس.</Text>
          <Button label="أرسلوا طلبًا آخر" variant="ghost" onPress={() => { setSent(false); setPicked([]); setForm({ ...form, note: '' }); }} />
        </Section>
      ) : (
        <Section title="اتركوا بياناتكم. نتواصل معكم.">
          <View style={styles.chips}>
            {SERVICES.map(([t]) => <Chip key={t} label={t} selected={picked.includes(t)} onPress={() => toggle(t)} />)}
          </View>
          <Field label="الاسم" value={form.name} onChangeText={(v) => put('name', v)} error={errors.name} autoComplete="name" maxLength={80} />
          <Field label="الشركة" value={form.company} onChangeText={(v) => put('company', v)} error={errors.company} autoComplete="organization" maxLength={120} />
          <Field label="الجوال" ltr value={form.phone} onChangeText={(v) => put('phone', v)} error={errors.phone} placeholder="05XXXXXXXX" keyboardType="phone-pad" autoComplete="tel" maxLength={16} />
          <Field label="بريد العمل" ltr value={form.email} onChangeText={(v) => put('email', v)} error={errors.email} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={80} />
          <View style={{ gap: space[2] }}>
            <Text variant="caption" mute>العدد التقريبي</Text>
            <View style={styles.chips}>
              {SIZES.map((s) => <Chip key={s} label={s} selected={form.size === s} onPress={() => put('size', form.size === s ? '' : s)} />)}
            </View>
          </View>
          <Field label="ما الذي في بالكم؟" size="body" multiline value={form.note} onChangeText={(v) => put('note', v)} maxLength={800} />
          <Text variant="caption" mute>نستخدم بياناتكم للتواصل بخصوص طلبكم فقط.</Text>
        </Section>
      )}
      <View style={{ height: space[8] }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  facts: { flexDirection: 'row', flexWrap: 'wrap', marginTop: space[8], borderTopWidth: 1, borderTopColor: color.line },
  fact: { width: '50%', paddingVertical: space[4], paddingEnd: space[3], gap: 2, borderBottomWidth: 1, borderBottomColor: color.line },
  row: { flexDirection: 'row', gap: space[3], paddingVertical: space[4], borderBottomWidth: 1, borderBottomColor: color.line },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
});
