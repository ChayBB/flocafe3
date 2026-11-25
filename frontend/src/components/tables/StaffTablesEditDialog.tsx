'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { StaffTableRangeForm } from '@/components/server-app/StaffTableRangeForm';
import type { StaffTablesDialogTable } from './StaffTablesDialog';

export default function StaffTablesEditDialog<T>({
  member,
  tables,
  backupEnabled = true,
  onClose,
  onSaved,
}: {
  member: { id: string; name: string };
  tables: StaffTablesDialogTable[];
  backupEnabled?: boolean;
  onClose: () => void;
  onSaved: (roster: T) => void;
}) {
  const t = useTranslations('tables');
  const [saving, setSaving] = useState(false);

  const save = async (ownIds: string[], backupIds: string[] | undefined) => {
    setSaving(true);
    try {
      const { data } = await api.put<T>('/tables/staff-tables/edit', {
        user_id: member.id,
        own_table_ids: ownIds,
        backup_table_ids: backupIds ?? [],
      });
      toast.success(t('staffTablesSaved'));
      onSaved(data);
    } catch {
      toast.error(t('staffTablesSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        data-testid="staff-tables-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('staffTablesEditTitle', { name: member.name })}
      >
        <StaffTableRangeForm
          tables={tables.map((table) => ({
            id: table.id,
            label: table.name,
            floor: table.floor,
            owner_user_id: table.owner_user_id,
            owner_name: table.owner_name,
            backup_user_id: table.backup_user_id,
          }))}
          userId={member.id}
          userName={member.name}
          backupEnabled={backupEnabled}
          saving={saving}
          manager
          title={t('staffTablesEditTitle', { name: member.name })}
          onSave={(ownIds, backupIds) => void save(ownIds, backupIds)}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
