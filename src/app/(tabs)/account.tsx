/** Account: the shop account (email code), its orders from the web and the app, where to deliver, and the quiet rows. */
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { View } from 'react-native';

import { CommunityAccountSection } from '@/community/AccountSection';
import { config, hasShop } from '@/config';
import { syncMyOrders, useAccount } from '@/store/account';
import { fmtDate, piecesLabel, statusLabel } from '@/store/format';
import { Section, useCartHeader } from '@/store/parts';
import { useOrders, useProfile } from '@/store/state';
import { gutter, space } from '@/theme';
import { Header, ListRow, Num, RailInset, Screen } from '@/ui';

export default function AccountScreen() {
  const router = useRouter();
  const orders = useOrders((s) => s.orders).filter((o) => o.status !== 'pending-payment').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const profile = useProfile();
  const header = useCartHeader();
  const address = [profile.city, profile.district, profile.street].filter(Boolean).join('، ');
  const account = useAccount();
  const signedIn = !!account.token;
  useQuery({ queryKey: ['me', 'orders', account.token], queryFn: async () => { await syncMyOrders(); return Date.now(); }, enabled: hasShop() && signedIn, staleTime: 60_000 });
  const signOut = () => {
    account.signOut();
    useOrders.getState().clear();
    profile.set({ fullName: '', mobile: '', email: '', city: '', district: '', street: '', extra: '' });
  };

  return (
    <RailInset>
    <Screen header={<Header title="حسابي" trailing={undefined} />} edges={['left', 'right']}>
      <View style={{ paddingBottom: space[16] }}>
        {config.communityEnabled ? <View style={{ marginTop: space[8], marginHorizontal: -gutter }}><CommunityAccountSection /></View> : null}

        {hasShop() ? (
          <Section title="حسابك" gap={0}>
            {signedIn ? (
              <>
                <ListRow padded={false} title={account.name ? `أهلًا، ${account.name.split(' ')[0]}.` : 'حسابك'} subtitle={account.email} />
                <ListRow padded={false} title="خروج" onPress={signOut} />
              </>
            ) : (
              <ListRow padded={false} chevron title="ادخل ببريدك" subtitle="نرسل لك رمزًا. طلباتك من الموقع والتطبيق هنا." onPress={() => router.push('/account/sign-in')} />
            )}
          </Section>
        ) : null}

        {orders.length > 0 || header.cartCount > 0 ? (
          <Section title="طلباتي" gap={0}>
            {orders.map((o) => (
              <ListRow key={o.id} padded={false} chevron title={statusLabel[o.status]} subtitle={`${piecesLabel(o.itemCount)} · ${fmtDate(o.createdAt)}`}
                trailing={<Num>{`#${o.number}`}</Num>} onPress={() => router.push({ pathname: '/order/[id]', params: { id: o.id } })} />
            ))}
            {header.cartCount > 0 ? <ListRow padded={false} chevron title="السلة" trailing={<Num>{String(header.cartCount)}</Num>} onPress={header.onPressCart} /> : null}
            <ListRow padded={false} chevron title={profile.fullName || 'العنوان'} subtitle={address || 'أضف عنوان التوصيل'} onPress={() => router.push('/account/address')} />
          </Section>
        ) : null}

        <Section title="wrk." gap={0}>
          <ListRow padded={false} chevron title="عن wrk." onPress={() => router.push('/intro')} />
          <ListRow padded={false} chevron title="المتجر" onPress={() => router.push('/store')} />
          <ListRow padded={false} chevron title="للشركات" subtitle="مجموعات بهوية شركتكم، من 10 قطع" onPress={() => router.push('/corporate')} />
          <ListRow padded={false} chevron title="تواصل معنا" subtitle={config.supportEmail} onPress={() => { WebBrowser.openBrowserAsync(`mailto:${config.supportEmail}`).catch(() => {}); }} />
          <ListRow padded={false} chevron title="الخصوصية" onPress={() => router.push({ pathname: '/legal/[doc]', params: { doc: 'privacy' } })} />
          <ListRow padded={false} chevron title="الشروط والاسترجاع" onPress={() => router.push({ pathname: '/legal/[doc]', params: { doc: 'terms' } })} />
        </Section>

        <Num style={{ marginTop: space[8] }} mute>{`wrk. ${Constants.expoConfig?.version ?? ''}`}</Num>
      </View>
    </Screen>
    </RailInset>
  );
}
