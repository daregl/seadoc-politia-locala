import { HttpException, HttpStatus } from '@nestjs/common';

export function fail(status: HttpStatus, message: string): never {
  throw new HttpException({ message }, status);
}
export const badRequest = (m: string): never => fail(HttpStatus.BAD_REQUEST, m);
export const forbidden = (m = 'Nu aveți drepturi pentru această acțiune'): never => fail(HttpStatus.FORBIDDEN, m);
export const notFound = (m = 'Nu a fost găsit'): never => fail(HttpStatus.NOT_FOUND, m);
export const conflict = (m: string): never => fail(HttpStatus.CONFLICT, m);

export function toInt(value: unknown, field = 'valoare'): number {
  const n = Number(value);
  if (!Number.isInteger(n)) badRequest(`Câmp invalid: ${field}`);
  return n;
}
export function optInt(value: unknown, field?: string): number | null {
  return value === undefined || value === null || value === '' ? null : toInt(value, field);
}
export function optText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  // Împiedică interpretarea celulei ca formulă în Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
