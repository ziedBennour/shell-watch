import type { ModelDay, ProjDay } from '../types'

// The Projet section's records: what a project costs and how long it was
// worked on, per day, per session process, per model.
//
// $.store keeps one key per process (`proj-1|<root>|p|<id>`), written by that
// process alone, so sessions running side by side never write over each other.
// Days before yesterday no longer change: they move into one archive key per
// project (`proj-1|<root>|a`), each day with the ids of the processes it holds.
// A day a process key still has while the archive names it is skipped, so a
// move counts once, and a process deletes its own day only on a later pass that
// still finds it in the archive (a write lost to a race is merged again).

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const emptyDay = (): ProjDay => ({ open: 0, work: 0, usd: 0, models: {} })
export const emptyModel = (): ModelDay => ({ usd: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** A stored day read back, every field checked. */
export const toDay = (v: unknown): ProjDay => {
  const o = obj(v)
  const d: ProjDay = { open: num(o.open), work: num(o.work), usd: num(o.usd), models: {} }
  for (const [id, m] of Object.entries(obj(o.models))) {
    const x = obj(m)
    d.models[id] = {
      usd: num(x.usd),
      input: num(x.input),
      cacheWrite: num(x.cacheWrite),
      cacheRead: num(x.cacheRead),
      output: num(x.output),
    }
  }
  return d
}

const toDays = (v: unknown): Record<string, ProjDay> => {
  const out: Record<string, ProjDay> = {}
  for (const [k, d] of Object.entries(obj(v))) if (DAY_KEY.test(k)) out[k] = toDay(d)
  return out
}

/** One process's record: when it last wrote, and its days. */
export type ProcRec = { at: number; days: Record<string, ProjDay> }
export const toProc = (v: unknown): ProcRec => ({ at: num(obj(v).at), days: toDays(obj(v).days) })

/** A project's archived days, each with the processes it holds. */
export type Archive = { days: Record<string, { from: string[]; rec: ProjDay }> }
export const toArchive = (v: unknown): Archive => {
  const out: Archive = { days: {} }
  for (const [k, a] of Object.entries(obj(obj(v).days))) {
    if (!DAY_KEY.test(k)) continue
    const from = obj(a).from
    out.days[k] = {
      from: Array.isArray(from) ? from.filter((x): x is string => typeof x === 'string') : [],
      rec: toDay(obj(a).rec),
    }
  }
  return out
}

export const addInto = (to: ProjDay, from: ProjDay) => {
  to.open += from.open
  to.work += from.work
  to.usd += from.usd
  for (const [id, m] of Object.entries(from.models)) {
    const t = (to.models[id] ??= emptyModel())
    t.usd += m.usd
    t.input += m.input
    t.cacheWrite += m.cacheWrite
    t.cacheRead += m.cacheRead
    t.output += m.output
  }
}

/** Stored as whole ms and tokens, $ to a millionth. */
export const roundDay = (d: ProjDay): ProjDay => {
  const r = (n: number) => Math.round(n)
  const u = (n: number) => Math.round(n * 1e6) / 1e6
  return {
    open: r(d.open),
    work: r(d.work),
    usd: u(d.usd),
    models: Object.fromEntries(
      Object.entries(d.models).map(([id, m]) => [
        id,
        { usd: u(m.usd), input: r(m.input), cacheWrite: r(m.cacheWrite), cacheRead: r(m.cacheRead), output: r(m.output) },
      ]),
    ),
  }
}

const two = (n: number) => String(n).padStart(2, '0')

/** The local day of a time: "2026-11-18". */
export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** The day `n` days from the one of `ms` (n < 0: before). */
export const dayShift = (ms: number, n: number) => {
  const d = new Date(ms)
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12).getTime())
}

/** "2026-11-18" → the local noon of that day, in ms. */
export const dayTime = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12).getTime()
}

/** Every process's days of a project as one per day: the archive, then each process's days it does not hold. */
export const mergeDays = (archive: Archive, procs: Iterable<readonly [string, Record<string, ProjDay>]>) => {
  const out = new Map<string, ProjDay>()
  const add = (day: string, rec: ProjDay) => {
    let d = out.get(day)
    if (!d) out.set(day, (d = emptyDay()))
    addInto(d, rec)
  }
  for (const [day, a] of Object.entries(archive.days)) add(day, a.rec)
  for (const [pid, days] of procs) {
    for (const [day, rec] of Object.entries(days)) if (!archive.days[day]?.from.includes(pid)) add(day, rec)
  }
  return out
}

/** The days from `from` on (all of them without it), summed. */
export const sumDays = (days: ReadonlyMap<string, ProjDay>, from?: string) => {
  const out = emptyDay()
  for (const [day, rec] of days) if (from === undefined || day >= from) addInto(out, rec)
  return out
}

/** A process whose key was not written for this long has ended. */
export const DEAD_MS = 2 * DAY

/**
 * What a pass of compaction does, decided from what was read: the days to
 * merge into the archive, the days a process can drop, the keys to delete.
 */
export const planCompaction = (
  now: number,
  archive: Archive,
  mine: { pid: string; days: Record<string, ProjDay> },
  others: ReadonlyMap<string, { pid: string; rec: ProcRec }>,
) => {
  const yesterday = dayShift(now, -1)
  const held = (pid: string, day: string) => archive.days[day]?.from.includes(pid) ?? false
  const merge: { pid: string; day: string; rec: ProjDay }[] = []
  const drop: string[] = []
  const remove: string[] = []
  for (const [day, rec] of Object.entries(mine.days)) {
    if (day >= yesterday) continue
    if (held(mine.pid, day)) drop.push(day)
    else merge.push({ pid: mine.pid, day, rec })
  }
  for (const [key, { pid, rec }] of others) {
    if (rec.at > now - DEAD_MS) continue
    const days = Object.keys(rec.days)
    if (days.some(d => d >= yesterday)) continue
    const left = days.filter(d => !held(pid, d))
    if (left.length === 0) remove.push(key)
    else for (const day of left) merge.push({ pid, day, rec: rec.days[day] as ProjDay })
  }
  return { merge, drop, remove }
}

/** Merges days into an archive, each process's day once. */
export const mergeArchive = (archive: Archive, merge: readonly { pid: string; day: string; rec: ProjDay }[]) => {
  for (const { pid, day, rec } of merge) {
    const a = (archive.days[day] ??= { from: [], rec: emptyDay() })
    if (a.from.includes(pid)) continue
    addInto(a.rec, rec)
    a.from.push(pid)
  }
  return archive
}

export const roundArchive = (a: Archive): Archive => ({
  days: Object.fromEntries(Object.entries(a.days).map(([k, v]) => [k, { from: v.from, rec: roundDay(v.rec) }])),
})

/**
 * A response's weight for sharing out a rise of the session's cost between
 * requests that ended together: its tokens at the ratios every Claude model
 * prices them at (cache write 1.25×, or 2× for an hour, cache read 0.1×,
 * output 5×). No price: the $ come from the session's own total.
 */
export const stepWeight = (t: {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  ephemeral_1h_input_tokens?: number
}) => {
  const long = t.ephemeral_1h_input_tokens ?? 0
  return (
    t.input_tokens +
    1.25 * Math.max(0, t.cache_creation_input_tokens - long) +
    2 * long +
    0.1 * t.cache_read_input_tokens +
    5 * t.output_tokens
  )
}

export { DAY, HOUR, MIN }
