/** Sign in to the shop: the email, then the 4-digit code we send to it. Same account as store.wrk.sa. No password, no SMS. */
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { hasShop } from '@/config';
import { finishSignIn } from '@/store/account';
import { toLatinDigits } from '@/store/format';
import { ShopError, sendCode } from '@/store/shop';
import { space } from '@/theme';
import { Button, EmptyState, Field, Num, Press, Screen, Text, haptic } from '@/ui';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function explain(e: unknown): string {
  if (e instanceof ShopError) {
    if (e.code === 'network') return 'تعذّر الاتصال. حاول مرة أخرى.';
    if (e.code === 'rejected' && e.message && !/^HTTP|bad /.test(e.message)) return e.message;
  }
  return 'حدث خطأ. حاول مرة أخرى.';
}

export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const countdown = (s: number) => {
    setWait(s);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => setWait((w) => { if (w <= 1 && timer.current) clearInterval(timer.current); return Math.max(0, w - 1); }), 1000);
  };

  if (!hasShop()) {
    return <Screen><EmptyState title="الدخول غير متاح في هذه النسخة." style={{ marginTop: space[16] }} /></Screen>;
  }

  const ask = async () => {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e)) { setError('اكتب بريدًا إلكترونيًا صحيحًا.'); haptic.warning(); return; }
    setBusy(true); setError(null);
    try {
      const r = await sendCode(e);
      setEmail(e); setStep('code'); setCode(''); countdown(r.retryIn);
    } catch (err) {
      haptic.error();
      setError(explain(err));
      if (err instanceof ShopError && err.retryIn) { setStep('code'); countdown(err.retryIn); }
    } finally { setBusy(false); }
  };

  const verify = async (value = code) => {
    if (value.length !== 4) { setError('اكتب الرمز من ٤ أرقام.'); haptic.warning(); return; }
    setBusy(true); setError(null);
    try {
      await finishSignIn(email, value);
      haptic.success();
      if (router.canGoBack()) router.back();
      else router.replace('/account');
    } catch (err) {
      haptic.error();
      setError(explain(err));
    } finally { setBusy(false); }
  };

  const footer = step === 'email'
    ? <Button label="أرسل الرمز" full loading={busy} haptic="tap" onPress={ask} />
    : <Button label="ادخل" full loading={busy} haptic="tap" onPress={() => verify()} />;

  return (
    <Screen edges={['left', 'right']} footer={footer}>
      <View style={{ gap: space[8], paddingTop: space[6] }}>
        <View style={{ gap: space[2] }}>
          <Text variant="display" accessibilityRole="header">{step === 'email' ? 'بريدك هو حسابك.' : 'اكتب الرمز.'}</Text>
          <Text variant="body" mute>
            {step === 'email' ? 'نرسل لك رمزًا وتدخل. طلباتك من الموقع والتطبيق في مكان واحد.' : 'أرسلناه إلى بريدك. صالح لخمس دقائق.'}
          </Text>
        </View>

        {step === 'email' ? (
          <Field label="البريد" ltr value={email} onChangeText={(v) => { setEmail(v); setError(null); }} error={error}
            keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress"
            autoFocus returnKeyType="send" onSubmitEditing={ask} maxLength={80} />
        ) : (
          <View style={{ gap: space[5] }}>
            <Num mute>{email}</Num>
            <Field label="الرمز" ltr value={code} error={error} autoFocus keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={4}
              onChangeText={(v) => { const d = toLatinDigits(v).replace(/\D/g, '').slice(0, 4); setCode(d); setError(null); if (d.length === 4) void verify(d); }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Press onPress={() => { setStep('email'); setError(null); }} accessibilityRole="button" hitSlop={10}>
                <Text variant="caption" mute style={{ textDecorationLine: 'underline' }}>غيّر البريد</Text>
              </Press>
              <Press onPress={wait > 0 || busy ? undefined : ask} disabled={wait > 0 || busy} accessibilityRole="button" hitSlop={10}>
                <Text variant="caption" mute style={wait > 0 ? undefined : { textDecorationLine: 'underline' }}>
                  {wait > 0 ? `رمز جديد بعد ${wait} ث` : 'أرسل رمزًا جديدًا'}
                </Text>
              </Press>
            </View>
          </View>
        )}
      </View>
    </Screen>
  );
}
