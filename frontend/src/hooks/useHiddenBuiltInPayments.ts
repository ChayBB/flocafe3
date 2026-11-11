import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { BUILT_IN_PAYMENT_SETTING, type BuiltInPaymentKey } from '@/lib/payment-methods';

/** Built-in tenders the shop has switched off; an unreadable setting keeps the tender shown. */
export function useHiddenBuiltInPayments(): ReadonlySet<BuiltInPaymentKey> {
  const [hidden, setHidden] = useState<ReadonlySet<BuiltInPaymentKey>>(new Set());
  useEffect(() => {
    let active = true;
    const keys = Object.keys(BUILT_IN_PAYMENT_SETTING) as BuiltInPaymentKey[];
    Promise.all(
      keys.map((key) =>
        api
          .get(`/settings/${BUILT_IN_PAYMENT_SETTING[key]}`)
          .then((res) => (res.data?.setting?.value === 'false' ? key : null))
          .catch(() => null),
      ),
    ).then((off) => {
      if (active) setHidden(new Set(off.filter((key): key is BuiltInPaymentKey => key !== null)));
    });
    return () => {
      active = false;
    };
  }, []);
  return hidden;
}
