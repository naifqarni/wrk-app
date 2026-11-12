/**
 * The store (القطع), as on store.wrk.sa/pieces: a short head with the name typed once, then a quiet grid. One still
 * photo per piece on the studio ground, its word, its plain name and its price. The kit takes a double tile.
 * No live 3D here; the piece turns on its own page.
 */
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { fromPrice, order, products, sample, still, stillRatio } from '@/store/catalogue';
import { usePersonal } from '@/store/state';
import type { ProductId } from '@/store/types';
import { useLive } from '@/store/useLive';
import { color, radius, space } from '@/theme';
import { Field, Press, Price, Screen, Text, useLayoutClass } from '@/ui';

export default function StoreScreen() {
  const router = useRouter();
  const live = useLive();
  const { isTwoPane, width } = useLayoutClass();
  const name = usePersonal((s) => s.name);
  const setPersonal = usePersonal((s) => s.set);
  const open = (id: ProductId) => router.push({ pathname: '/product/[id]', params: { id } });
  const cols = isTwoPane || width >= 820 ? 3 : 2;

  const head = (
    <View style={[styles.head, isTwoPane && { flexDirection: 'row', alignItems: 'flex-end' }]}>
      <View style={{ flex: isTwoPane ? 1 : undefined, gap: space[1] }}>
        <Text variant="display" accessibilityRole="header" style={styles.h}>القطع.</Text>
        <Text variant="body" mute>كل قطعة لحظة من أول يوم.</Text>
      </View>
      <View style={{ flex: isTwoPane ? 1 : undefined }}>
        <Field
          label="الاسم"
          value={name}
          onChangeText={(v) => setPersonal('name', v)}
          placeholder={sample.name}
          hint="اكتبه مرة، ويظهر على كل قطعة تفتحها."
          autoCorrect={false}
          autoCapitalize="words"
          returnKeyType="done"
          maxLength={28}
        />
      </View>
    </View>
  );

  const tile = (id: ProductId) => {
    const p = products[id];
    const kit = id === 'kit';
    const f = fromPrice(id, live?.price);
    return (
      <Press key={id} onPress={() => open(id)} accessibilityRole="link" accessibilityLabel={`${p.word}، ${p.ar}`} pressScale={0.985}
        style={[styles.tile, { width: kit ? '100%' : `${100 / cols}%` }]}>
        <View style={styles.shot}>
          <Image source={still(id)} style={{ width: '100%', aspectRatio: stillRatio(id) }} contentFit="cover" transition={200}
            accessibilityLabel={p.ar} />
        </View>
        <View style={styles.cap}>
          <View style={{ flex: 1 }}>
            <Text variant="headline">{p.word}</Text>
            <Text variant="caption" mute>{p.ar}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space[1] }}>
            {f.from ? <Text variant="caption" mute>من</Text> : null}
            <Price amount={f.price} />
          </View>
        </View>
      </Press>
    );
  };

  return (
    <Screen edges={['left', 'right', 'bottom']} maxWidth={isTwoPane ? 1180 : 760}>
      <View style={{ gap: space[8], paddingTop: space[6], paddingBottom: space[16] }}>
        {head}
        <View style={styles.grid}>{order.map(tile)}</View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: space[6] },
  h: { fontSize: 40, lineHeight: 58 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -space[2], rowGap: space[6] },
  tile: { paddingHorizontal: space[2], gap: space[3] },
  shot: { borderRadius: radius.panel, overflow: 'hidden', backgroundColor: color.stock },
  cap: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2], paddingHorizontal: space[1] },
});
