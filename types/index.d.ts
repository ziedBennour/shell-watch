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
  /** %/h over the recent span (or the window so far); absent while too early to measure */
  rate?: number
  /** ms the rate is measured over */
  span?: number
  /** %/h that would land exactly on 100 % at the reset */
  sustain: number
  /** when the limit is reached at `rate`, if before the reset */
  hitAt?: number
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

declare module 'claude-code' {
  interface PluginState {
    'shell-watch': {
      shells: Shaped<Shell[]>
      usage: Shaped<Usage>
      expanded: Shaped<string | null>
      filter: Shaped<ShellFilter>
      tokens: Shaped<Tokens>
      agents: Shaped<AgentRun[]>
    }
  }
}
