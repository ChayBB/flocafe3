import { getDatabase, getSettingValue } from '../db';
import { parsePromptPayAccount, type PromptPayTarget } from './promptpay';

export const QR_ACCOUNT_SETTING = 'qr_payment_account';
/**
 * The PromptPay ID (phone, national/tax ID or e-wallet) registered to the shop's bank account.
 * A plain bank account number cannot be paid through a PromptPay QR: that proxy type is reserved.
 */
export const BANK_QR_ACCOUNT_SETTING = 'bank_qr_account';

/** Name of the PromptPay account holder, printed under the payment QR so customers see who they pay. */
export const QR_ACCOUNT_NAME_SETTING = 'qr_payment_account_name';
export const QR_ACCOUNT_NAME_MAX_LENGTH = 60;

export function normalizeQrAccountName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim().replace(/\s+/g, ' '))
    .slice(0, QR_ACCOUNT_NAME_MAX_LENGTH)
    .join('')
    .trim();
}

/** The holder name for a payment QR; only the PromptPay QR account has one. */
export function readPaymentQrAccountName(kind: PaymentQrKind = 'promptpay'): string {
  return kind === 'promptpay'
    ? normalizeQrAccountName(getSettingValue(QR_ACCOUNT_NAME_SETTING))
    : '';
}

export type PaymentQrKind = 'promptpay' | 'bank';

export function parsePaymentQrKind(value: unknown): PaymentQrKind {
  return value === 'bank' ? 'bank' : 'promptpay';
}

function settingFor(kind: PaymentQrKind): string {
  return kind === 'bank' ? BANK_QR_ACCOUNT_SETTING : QR_ACCOUNT_SETTING;
}

export function readPaymentQrAccount(kind: PaymentQrKind): string {
  const value = getSettingValue(settingFor(kind)) || '';
  return parsePromptPayAccount(value) ? value : '';
}

/** The PromptPay target a payment QR pays into for the "QR Code" or "Bank account" method. */
export function resolvePaymentQrTarget(kind: PaymentQrKind): PromptPayTarget | null {
  return parsePromptPayAccount(getSettingValue(settingFor(kind)));
}

export function missingQrAccountCode(kind: PaymentQrKind): string {
  return kind === 'bank' ? 'bank_qr_account_missing' : 'qr_account_missing';
}

const PROMPTPAY_METHOD_NAMES = new Set(['qr code', 'พร้อมเพย์', 'promptpay']);

/** A custom method collects by PromptPay QR when its name is "QR Code" or mentions PromptPay. */
export function isPromptPayMethodName(name: unknown): boolean {
  const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return PROMPTPAY_METHOD_NAMES.has(key) || key.includes('พร้อมเพย์') || key.includes('promptpay');
}

/** The payment method whose PromptPay QR prints on bills; unset prints the shop's main account. */
export const BILL_QR_METHOD_SETTING = 'bill_qr_payment_method_id';

export interface PromptPayMethodRow {
  id: number;
  name: string;
  is_active: number | boolean;
}

export function listPromptPayMethods(): PromptPayMethodRow[] {
  return (
    getDatabase()
      .prepare('SELECT id, name, is_active FROM payment_methods ORDER BY id')
      .all() as PromptPayMethodRow[]
  ).filter((row) => isPromptPayMethodName(row.name));
}

/**
 * The oldest PromptPay method keeps the shop's main account settings; every later one stores its
 * own account under its id, so a second method can hold, say, a phone number beside a national ID.
 */
export function promptPayMethodSettings(
  methodId: number,
  methods: PromptPayMethodRow[] = listPromptPayMethods(),
): { account: string; name: string } | null {
  if (!methods.some((row) => row.id === methodId)) return null;
  return methods[0].id === methodId
    ? { account: QR_ACCOUNT_SETTING, name: QR_ACCOUNT_NAME_SETTING }
    : { account: `promptpay_account_${methodId}`, name: `promptpay_account_name_${methodId}` };
}

export interface PromptPayMethodAccount {
  method_id: number;
  account: string;
  name: string;
}

export function readPromptPayMethodAccounts(): PromptPayMethodAccount[] {
  const methods = listPromptPayMethods();
  return methods.map((row) => {
    const keys = promptPayMethodSettings(row.id, methods)!;
    const account = getSettingValue(keys.account) || '';
    return {
      method_id: row.id,
      account: parsePromptPayAccount(account) ? account : '',
      name: normalizeQrAccountName(getSettingValue(keys.name)),
    };
  });
}

export function readBillQrMethodId(): number | null {
  const id = Number(getSettingValue(BILL_QR_METHOD_SETTING));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The PromptPay account and holder name printed on bills. */
export function resolveBillPaymentQr(): { target: PromptPayTarget; accountName: string } | null {
  const chosen = readBillQrMethodId();
  if (chosen !== null) {
    const methods = listPromptPayMethods();
    const method = methods.find((row) => row.id === chosen);
    const keys = method?.is_active ? promptPayMethodSettings(chosen, methods) : null;
    const target = keys ? parsePromptPayAccount(getSettingValue(keys.account)) : null;
    if (keys && target) {
      return { target, accountName: normalizeQrAccountName(getSettingValue(keys.name)) };
    }
  }
  const target = resolvePaymentQrTarget('promptpay');
  return target ? { target, accountName: readPaymentQrAccountName('promptpay') } : null;
}

/** The account a payment QR pays: the bill's PromptPay account, or the bank's PromptPay ID. */
export function resolvePaymentQr(
  kind: PaymentQrKind,
): { target: PromptPayTarget; accountName: string } | null {
  if (kind === 'promptpay') return resolveBillPaymentQr();
  const target = resolvePaymentQrTarget(kind);
  return target ? { target, accountName: readPaymentQrAccountName(kind) } : null;
}
