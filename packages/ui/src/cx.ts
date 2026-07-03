export type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  let out = '';
  for (const value of values) {
    if (value) {
      out = out.length > 0 ? `${out} ${value}` : value;
    }
  }
  return out;
}
