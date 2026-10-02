/**
 * The Git sub-view's fetch clock, client side. The six interval values are a literal here and another in `server/lib/settings.ts`: no runtime constant crosses
 * `shared/`, so each side pins its own list with a test. The segment labels sit beside their values because the Settings card is their only reader.
 */
export const GIT_FETCH_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 120, label: '2m' },
  { value: 300, label: '5m' },
  { value: 600, label: '10m' },
];
