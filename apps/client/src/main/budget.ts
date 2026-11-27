/**
 * The member's daily spending cap and today's spend (spin-out spec v2, 6.4, 9.3), kept in the
 * encrypted cache. Spend is what the model proxy reports per call. The tightest of the node's own
 * cap and each joined Henge's member cap applies.
 */
import { addSpend, capDecision, effectiveCap, localDay, spentToday, type CapDecision, type SpendDay } from '@swarm-explorer/node-core';
import { z } from 'zod';
import type { EncryptedCache } from './cache';

const settingsSchema = z.object({ dailyCapUsdMicros: z.number().int().nonnegative().nullable() });
const spendSchema = z.object({ day: z.string(), usdMicros: z.number().int().nonnegative() });

export type BudgetView = { dailyCapUsdMicros: number | null; spentTodayUsdMicros: number; capReached: boolean };

export class BudgetManager {
  constructor(
    private d: {
      cache: () => EncryptedCache;
      /** Member caps of joined Henges, in USD micros. */
      hengeCaps?: () => Array<number | null>;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.d.now?.() ?? new Date();
  }

  ownCap(): number | null {
    const s = settingsSchema.safeParse(this.d.cache().get('budget-settings'));
    return s.success ? s.data.dailyCapUsdMicros : null;
  }

  cap(): number | null {
    return effectiveCap(this.ownCap(), ...(this.d.hengeCaps?.() ?? []));
  }

  setDailyCap(usdMicros: number | null) {
    this.d.cache().set('budget-settings', settingsSchema.parse({ dailyCapUsdMicros: usdMicros }));
  }

  private day(): SpendDay | null {
    const s = spendSchema.safeParse(this.d.cache().get('spend-day'));
    return s.success ? s.data : null;
  }

  spent(): number {
    return spentToday(this.day(), this.now());
  }

  today(): string {
    return localDay(this.now());
  }

  record(usdMicros: number) {
    this.d.cache().set('spend-day', addSpend(this.day(), usdMicros, this.now()));
  }

  check(): CapDecision {
    return capDecision(this.cap(), this.spent());
  }

  view(): BudgetView {
    return { dailyCapUsdMicros: this.cap(), spentTodayUsdMicros: this.spent(), capReached: !this.check().ok };
  }
}
