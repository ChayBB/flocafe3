export type StatusKey =
  | 'starting'
  | 'checking'
  | 'backingUp'
  | 'services'
  | 'welcome'
  | 'closing'
  | 'shutdownBackup'
  | 'saved';

export type StatusMessage = readonly [title: string, detail: string];
type StatusTable = Record<StatusKey, StatusMessage>;

const en: StatusTable = {
  starting: ['Starting Flo', 'Getting everything ready…'],
  checking: ['Checking your data', 'Verifying the database and keeping it healthy…'],
  backingUp: ['Backing up your data', 'Saving a safe copy before you start…'],
  services: ['Starting services', 'Almost there…'],
  welcome: ['Welcome to Flo', 'Opening your workspace…'],
  closing: ['Closing Flo', 'Saving your data. Please do not turn off the computer.'],
  shutdownBackup: ['Taking a backup', 'Please do not turn off the computer.'],
  saved: ['All saved', 'Flo will close in a moment.'],
};

const TABLES: Record<string, StatusTable> = {
  en,
  th: {
    starting: ['กำลังเริ่ม Flo', 'กำลังเตรียมทุกอย่าง…'],
    checking: ['กำลังตรวจสอบข้อมูลของคุณ', 'กำลังตรวจสอบฐานข้อมูลและดูแลให้อยู่ในสภาพดี…'],
    backingUp: ['กำลังสำรองข้อมูล', 'กำลังบันทึกสำเนาที่ปลอดภัยก่อนเริ่มใช้งาน…'],
    services: ['กำลังเริ่มบริการ', 'เกือบเสร็จแล้ว…'],
    welcome: ['ยินดีต้อนรับสู่ Flo', 'กำลังเปิดพื้นที่ทำงานของคุณ…'],
    closing: ['กำลังปิด Flo', 'กำลังบันทึกข้อมูลของคุณ กรุณาอย่าปิดคอมพิวเตอร์'],
    shutdownBackup: ['กำลังสำรองข้อมูล', 'กรุณาอย่าปิดคอมพิวเตอร์'],
    saved: ['บันทึกทั้งหมดแล้ว', 'Flo จะปิดในอีกสักครู่'],
  },
};

export const STATUS_LANGUAGES: readonly string[] = Object.keys(TABLES);

/** Maps a store language or OS locale tag (en-US, th-TH) to a language with messages. */
export function resolveStatusLanguage(tag: string | null | undefined): string {
  const normalized = String(tag ?? '')
    .toLowerCase()
    .replace('_', '-');
  if (TABLES[normalized]) return normalized;
  const base = normalized.split('-')[0];
  return TABLES[base] ? base : 'en';
}

export function getStatusMessage(key: StatusKey, language: string): StatusMessage {
  return (TABLES[language] ?? en)[key];
}
