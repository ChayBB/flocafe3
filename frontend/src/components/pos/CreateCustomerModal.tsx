'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { useTranslations } from 'use-intl';
import { normalizeOptionalPhone } from '@/lib/phone';
import { countryName } from '@/lib/countries';
import type { Customer } from '@/lib/types';
import { disambiguateCustomerInput } from '@/lib/customer-disambiguation';
import CustomerDetailsFields, {
  EMPTY_CUSTOMER_DETAILS,
  type CustomerDetailsValue,
} from '@/components/customers/CustomerDetailsFields';

interface Props {
  initialSearch?: string;
  initialField?: 'phone' | 'name';
  onClose: () => void;
  onCreated: (customer: Customer) => void;
}

export default function CreateCustomerModal({
  initialSearch = '',
  initialField,
  onClose,
  onCreated,
}: Props) {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const country = currentTenant?.country ?? '';

  const initialClassification = disambiguateCustomerInput(initialSearch);
  const targetField =
    initialField ?? (initialClassification.category === 'name' ? 'name' : 'phone');
  const isPhoneInitial = targetField === 'phone';

  const [form, setForm] = useState<CustomerDetailsValue>(() => ({
    ...EMPTY_CUSTOMER_DETAILS,
    firstName: isPhoneInitial ? '' : initialSearch.trim(),
    phone: isPhoneInitial ? initialSearch.trim() : '',
  }));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saving, onClose]);

  const handleSwapFields = () => {
    setForm((prev) => ({ ...prev, firstName: prev.phone, phone: prev.firstName }));
  };

  const handleSave = async () => {
    if (!form.firstName.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    const norm = normalizeOptionalPhone(form.phone.trim(), country);
    if (!norm.valid) {
      toast.error(t('invalidPhone', { country: countryName(country) }));
      return;
    }

    setSaving(true);
    try {
      const { data } = await api.post('/customers', {
        first_name: form.firstName.trim(),
        last_name: form.lastName.trim(),
        phone: norm.e164 ?? '',
        country_code: norm.countryCode ?? '',
        birthday: form.birthday,
        notes: form.notes.trim(),
      });
      onCreated(data.customer);
      toast.success(t('customerCreated'));
      onClose();
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const errorMsg =
          (err.response?.data as { message?: string; error?: string } | undefined)?.message ||
          (err.response?.data as { message?: string; error?: string } | undefined)?.error ||
          t('createCustomerFailed');
        toast.error(errorMsg);
      } else {
        toast.error(t('createCustomerFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto p-5 shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-foreground">{t('addCustomer')}</h3>
          <button
            onClick={onClose}
            disabled={saving}
            className="touch-target rounded-full text-gray-400 hover:text-muted-foreground active:bg-muted disabled:opacity-50"
            aria-label={t('close')}
          >
            <X size={20} />
          </button>
        </div>
        <CustomerDetailsFields
          value={form}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          autoFocusField={isPhoneInitial ? 'phone' : 'firstName'}
          onSwapNameAndPhone={handleSwapFields}
        />
        <div className="flex gap-2 mt-5">
          <Button variant="outline" onClick={onClose} disabled={saving} className="flex-1">
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving} className="flex-1">
            {saving ? t('loadingEllipsis') : tCommon('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
