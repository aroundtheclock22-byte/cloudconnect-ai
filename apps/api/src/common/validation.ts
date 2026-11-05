import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

export class ZodPipe<T> implements PipeTransform {
  constructor(private schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) throw new BadRequestException({ message: 'Validation failed', issues: r.error.issues });
    return r.data;
  }
}
export const z$ = <T>(s: ZodSchema<T>) => new ZodPipe(s);

/** Cursor-free pagination for list endpoints. */
export function page(q: { limit?: string; offset?: string }) {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  return { limit, offset };
}
