export type ShellStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'background'
  | 'bg-done'
  | 'bg-failed'

export type Shell = {
  /** tool_use_id of the Bash call */
  id: string
  command: string
  description?: string
  /** set when a subagent ran it */
  agent?: string
  startedAt: number
  endedAt?: number
  status: ShellStatus
  /** background task id */
  taskId?: string
  /** live output file being tailed */
  file?: string
  /** last lines of output */
  tail: string[]
  /** the command's exit code, when known */
  exitCode?: number
}

/** Where a subagent stands, as `$.agent.list()` gives it. */
export type AgentRunStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/** A subagent the session started, with what it has done so far. */
export type AgentRun = {
  id: string
  description: string
  /** agent type: general-purpose, Explore, … */
  type: string
  /** the model it runs on */
  model?: string
  /** effort of its last model request (low … max, or a number) */
  effort?: string
  background: boolean
  /** set when another subagent spawned it */
  parentId?: string
  startedAt: number
  endedAt?: number
  status: AgentRunStatus
  /** tool calls made */
  tools: number
  /** tokens used, cache reads left out */
  tokens: number
  /** its last tool call, in a few words */
  last?: string
}

/** Which shells the list shows: all, foreground running, background running, succeeded, failed, interrupted. */
export type ShellFilter = 'all' | 'running' | 'background' | 'success' | 'error' | 'stopped'

export type Limit = { kind: string; percent: number; resetsAt?: string }

/** How fast a rate-limit window fills, read from the readings kept across sessions. */
export type Pace = {
  /** %/h averaged since the window began; absent while too early to measure */
  rate?: number
  /** ms the rate is measured over: the window so far */
  span?: number
  /** %/h that would land exactly on 100 % at the reset */
  sustain: number
  /** when the limit is reached at `rate`, if before the reset */
  hitAt?: number
  /** how far past 100 % it would be at the reset at `rate`, when `hitAt` is set */
  over?: number
  /** the % expected at the reset at `rate`, when the limit is not reached first */
  atReset?: number
}

/** Tokens this session's model requests used (main loop and subagents), cache reads left out. */
export type Tokens = {
  sid: string
  /** when counting began */
  since: number
  total: number
}

export type Usage = {
  at: number
  /** when the session began (launch, first launch if resumed, or last /clear) */
  startedAt?: number
  /** the session's model id (claude-opus-5-5, …) */
  model?: string
  /** effort of the last main-loop model request (low … max, or a number) */
  effort?: string
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow?: number
  usd?: number
  limits: Limit[]
  /** per limit kind (five_hour, seven_day…) */
  pace?: Record<string, Pace>
}

/** A model's part of a project's work: its cost and its tokens by kind. */
export type ModelDay = {
  /** $ at API prices (an estimate, not the subscription's bill) */
  usd: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  /** ms this model was at work (its turns, its subagents'), counted since 0.20.0 */
  time: number
}

/** Work on a project over a span: times in ms, cost in $ at API prices, per model id. */
export type ProjDay = {
  /** the session open (ticks of the timer; a machine asleep does not count) */
  open: number
  /** someone at work: the person present, or the model in a turn or a subagent */
  work: number
  usd: number
  models: Record<string, ModelDay>
}

/** What the Projet section shows, every session on the project summed. */
export type ProjectView = {
  /** the session's folder; '' until known */
  root: string
  /** the current session (since its start, through restarts; /clear starts another) */
  session: ProjDay
  /** since the 7-day window's reset, or the last 7 days when it is not known */
  week: ProjDay
  /** whether `week` starts at the 7-day window's reset */
  weekReset: boolean
  total: ProjDay
  /** the first day counted ("2026-10-30"), every machine's; '' when none */
  since: string
}

/** Sections of the pane that fold: their titles' keys. */
export type Section = 'usage' | 'project' | 'agents' | 'shells'

declare module 'claude-code' {
  interface PluginState {
    'shell-watch': {
      shells: Shaped<Shell[]>
      usage: Shaped<Usage>
      expanded: Shaped<string | null>
      filter: Shaped<ShellFilter>
      tokens: Shaped<Tokens>
      agents: Shaped<AgentRun[]>
      project: Shaped<ProjectView>
      folded: Shaped<Section[]>
      /** this process's id: its record's key in $.store */
      proc: Shaped<string>
      /** whether the sound plays when Claude is done */
      sound: Shaped<boolean>
    }
  }
}
