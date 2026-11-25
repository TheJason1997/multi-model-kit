import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { CODEX_READY_SH, RECORD_ONLY_SWITCH, codexText, decide, lowerEffort, unexplainedBlock } from './register.ts'
import type { OrgState, Situation } from './register.ts'

const T0 = 1_700_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(ms).toISOString()
const SID = 'a1b2c3d4-0000-4000-8000-000000000001'
const HANDOFF = '/tmp/claude-org-test/handoff'

const free: OrgState = {}
const spent = (kind: 'five_hour' | 'seven_day', until: number): OrgState => ({
  ledger: { seenAt: T0, windows: { [kind]: { percentUsed: 100, resetsAt: iso(until) } } },
})
const situation = (s: Partial<Situation>): Situation => ({
  now: T0,
  current: 'a',
  orgs: ['a', 'b'],
  fable: false,
  why: 'window',
  states: { a: free, b: free },
  ...s,
})

// ---- the strategy, no engine ----

test('5h window at 95% here, other org idle: move there with the session', () => {
  const states = { a: { ledger: { seenAt: T0, windows: { five_hour: { percentUsed: 95, resetsAt: iso(T0 + HOUR) } } } }, b: free }
  expect(decide(situation({ states }))).toEqual({ kind: 'move', org: 'b', go: false })
})

test('95% here, other org\'s 7d window full and not reset: stay put', () => {
  const states = { a: spent('five_hour', T0 + HOUR), b: spent('seven_day', T0 + 2 * 24 * HOUR) }
  expect(decide(situation({ states }))).toEqual({ kind: 'stay' })
})

test('Fable limited, windows fine, other org\'s Fable held off: Opus here, no org change', () => {
  const states = { a: { block: { kind: 'fable' as const, until: T0 + 30 * MIN } }, b: { block: { kind: 'fable' as const, until: T0 + 10 * MIN } } }
  expect(decide(situation({ why: 'fable', fable: true, states }))).toEqual({ kind: 'move', org: 'a', model: 'claude-opus-5-5', go: true })
})

test('a Fable limit no window explains holds this org\'s Fable off for 30 min', () => {
  expect(unexplainedBlock('fable', free, true, T0)).toEqual({ kind: 'fable', until: T0 + 30 * MIN })
  expect(unexplainedBlock('limit', free, false, T0)).toEqual({ kind: 'all', until: T0 + 30 * MIN })
  expect(unexplainedBlock('limit', spent('five_hour', T0 + HOUR), false, T0)).toBeUndefined()
  expect(unexplainedBlock('window', free, false, T0)).toBeUndefined()
})

test('every org limited: wait for the one that frees first (its latest spent window binds)', () => {
  const states = {
    a: spent('five_hour', T0 + HOUR),
    b: { ledger: { seenAt: T0, windows: { five_hour: { percentUsed: 100, resetsAt: iso(T0 + 10 * MIN) }, seven_day: { percentUsed: 100, resetsAt: iso(T0 + 48 * HOUR) } } } },
  }
  expect(decide(situation({ why: 'limit', states }))).toEqual({ kind: 'wait', org: 'a', at: T0 + HOUR })
})

test('switched under two minutes ago: no immediate switch back, wait out the cooldown', () => {
  const states = { a: spent('five_hour', T0 + HOUR), b: free }
  expect(decide(situation({ why: 'limit', states, lastSwitchAt: T0 - 30_000 }))).toEqual({ kind: 'wait', org: 'b', at: T0 + 90_000 })
  expect(decide(situation({ why: 'limit', states, lastSwitchAt: T0 - 3 * MIN }))).toEqual({ kind: 'move', org: 'b', go: true })
})

// ---- the mod in an engine ----

type Run = { exitCode: number; stdout?: string; stderr?: string }
type World = {
  writes: { path: string; text: string }[]
  commands: string[]
  toasts: string[]
  prompts: string[]
  model: string
  runs: (readonly string[])[]
  efforts: unknown[]
  files: Set<string>
  status: string
}

function world(on: On, opts: { model?: string; run?: (argv: readonly string[]) => Run; limits?: { kind: string; percentUsed: number; resetsAt?: string }[] } = {}): World {
  const w: World = { writes: [], commands: [], toasts: [], prompts: [], model: opts.model ?? 'claude-opus-5-5', runs: [], efforts: [], files: new Set(), status: '' }
  on('session.model', () => ({ value: w.model }))
  on('prompt.submit', (_$, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: SID }))
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits: opts.limits ?? [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', (_$, e) => {
    w.commands.push(e.command === 'model' ? `model ${e.args}` : e.command)
    if (e.command === 'model') w.model = e.args
    return { text: '' }
  })
  on('process.run', (_$, e) => {
    w.runs.push(e.argv)
    const r = opts.run?.(e.argv) ?? (isReadyCheck(e.argv) ? NOT_A_REPO : { exitCode: 0 })
    return { value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) }))
  on('turn.step', async function* (_$, e) {
    w.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  })
  on('fs.write', (_$, e) => {
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.status = e.text ?? ''
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  return w
}

/** A store the test can read back. */
function memStore(on: On, init: Record<string, unknown> = {}): Record<string, unknown> {
  const m: Record<string, unknown> = { ...init }
  on('store.get', (_$, e) => ({ value: m[e.key] }))
  on('store.set', (_$, e) => {
    m[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete m[e.key]
    return { value: undefined }
  })
  return m
}

const launcherEnv = { CLAUDE_ORG: 'a', CLAUDE_ORGS: 'a,b', CLAUDE_ORG_HANDOFF: HANDOFF, CLAUDE_ORG_RESUMED: '1' }
const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const measure = ($: Engine, fiveHour: number, contextPct = 3) =>
  $.session.measure({
    context: { window: 200_000, tokens: 2_000 * contextPct, percent: contextPct },
    rateLimits: [
      { kind: 'five_hour', percentUsed: fiveHour, resetsAt: iso(T0 + HOUR) },
      { kind: 'seven_day', percentUsed: 50, resetsAt: iso(T0 + 3 * 24 * HOUR) },
    ],
    changed: ['rateLimits'],
  })
const org = ($: Engine, args: string) =>
  $.command.run({ command: 'org', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const rateLimited = ($: Engine) =>
  $.classic.StopFailure({ session_id: SID, transcript_path: '/tmp/t.jsonl', cwd: '/tmp', error: 'rate_limit' })

test('window at 95%: records the reading, writes target org and session id to the handoff file, exits', async ($, on) => {
  mock.env(on, launcherEnv)
  // a store the test can read back
  const sets: Record<string, unknown> = {}
  on('store.get', (_$, e) => ({ value: sets[e.key] }))
  on('store.set', (_$, e) => {
    sets[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete sets[e.key]
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 95)
  await clock.advance(1)
  expect(w.writes).toEqual([{ path: HANDOFF, text: `next=b\nsession=${SID}\nreason=a: 5h window at 95%\n` }])
  expect(w.commands).toEqual(['exit'])
  expect(sets['ledger:a']).toEqual({
    seenAt: T0,
    windows: { five_hour: { percentUsed: 95, resetsAt: iso(T0 + HOUR) }, seven_day: { percentUsed: 50, resetsAt: iso(T0 + 3 * 24 * HOUR) } },
  })
})

test('context past half: compacts before the switch', async ($, on) => {
  mock.env(on, launcherEnv)
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 96, 60)
  await clock.advance(1)
  expect(w.commands).toEqual(['compact', 'exit'])
})

test('Fable limited on every org: switches model to Opus here and continues', async ($, on) => {
  mock.env(on, launcherEnv)
  mock.store(on, { 'block:b': { kind: 'fable', until: T0 + 10 * MIN } })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { model: 'claude-fable-5-2' })
  await start($)
  await measure($, 40)
  await rateLimited($)
  await clock.advance(1)
  expect(w.writes).toEqual([])
  expect(w.model).toBe('claude-opus-5-5')
  expect(w.prompts).toEqual(['继续'])
})

test('every org limited: waits, and a turn that works meanwhile cancels the wait', async ($, on) => {
  mock.env(on, launcherEnv)
  mock.store(on, { 'ledger:b': { seenAt: T0, windows: { five_hour: { percentUsed: 100, resetsAt: iso(T0 + 2 * HOUR) } } } })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 100)
  await rateLimited($)
  await clock.advance(1)
  expect(w.toasts[w.toasts.length - 1]).toBe('org-switch: every org is limited. a frees in 1.0 h; retrying in 30 min for a reset.')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(31 * MIN)
  expect(w.prompts).toEqual([])
})

test('every org limited and nothing works: the wait ends in a "继续" probe', async ($, on) => {
  mock.env(on, launcherEnv)
  mock.store(on, { 'ledger:b': { seenAt: T0, windows: { five_hour: { percentUsed: 100, resetsAt: iso(T0 + 2 * HOUR) } } } })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 100)
  await rateLimited($)
  await clock.advance(1)
  await clock.advance(30 * MIN + 5_000)
  expect(w.prompts).toEqual(['继续'])
})

test('waiting for the other org, whose reset moved later meanwhile: no handoff to it, decides again', async ($, on) => {
  mock.env(on, launcherEnv)
  const store = memStore(on, { 'ledger:b': { seenAt: T0, windows: { five_hour: { percentUsed: 100, resetsAt: iso(T0 + 10 * MIN) } } } })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 100) // a frees in 1 h, b in 10 min: wait for b
  await rateLimited($)
  await clock.advance(1)
  expect(w.toasts[w.toasts.length - 1]).toBe('org-switch: every org is limited. b frees in 10 min; continuing then.')
  store['ledger:b'] = { seenAt: T0 + MIN, windows: { five_hour: { percentUsed: 100, resetsAt: iso(T0 + 3 * HOUR) } } } // another session used b up
  await clock.advance(10 * MIN + 5_000)
  expect(w.writes).toEqual([])
  expect(w.prompts).toEqual([])
  expect(w.toasts[w.toasts.length - 1]).toBe('org-switch: every org is limited. a frees in 50 min; retrying in 30 min for a reset.')
})

test('95% inside the switch cooldown: the move after it keeps "no 继续" and the current model', async ($, on) => {
  mock.env(on, launcherEnv)
  const store = memStore(on, { lastSwitchAt: T0 - 30_000 })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { model: 'claude-fable-5-2' })
  await start($)
  await measure($, 95)
  await clock.advance(1)
  expect(w.writes).toEqual([])
  await clock.advance(90_000 + 5_000)
  expect(w.writes).toEqual([{ path: HANDOFF, text: `next=b\nsession=${SID}\nreason=a: 5h window at 95%\n` }])
  expect(store[`resume:${SID}`]).toEqual({ go: false, model: 'claude-fable-5-2' })
  expect(w.prompts).toEqual([])
})

test('95% in the cooldown, then a real limit before it ends: the switch it was waiting for continues the turn', async ($, on) => {
  mock.env(on, launcherEnv)
  const store = memStore(on, { lastSwitchAt: T0 - 30_000 })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 95)
  await clock.advance(1)
  await measure($, 100)
  await rateLimited($)
  await clock.advance(1)
  expect(w.writes).toEqual([])
  await clock.advance(90_000 + 5_000)
  expect(w.writes).toEqual([{ path: HANDOFF, text: `next=b\nsession=${SID}\nreason=a: 5h window at 100%\n` }])
  expect(store[`resume:${SID}`]).toEqual({ go: true, model: 'claude-opus-5-5' })
})

test('a plugin above swallowed the limit failure: a turn ended by an error at 100% still continues on the other org', async ($, on) => {
  mock.env(on, launcherEnv)
  const store = memStore(on, { lastSwitchAt: T0 - 30_000 })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 100)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'error' })
  await clock.advance(90_000 + 5_000)
  expect(w.writes).toEqual([{ path: HANDOFF, text: `next=b\nsession=${SID}\nreason=a: 5h window at 100%\n` }])
  expect(store[`resume:${SID}`]).toEqual({ go: true, model: 'claude-opus-5-5' })
})

test('a turn ended by an error with the windows fine: nothing moves', async ($, on) => {
  mock.env(on, launcherEnv)
  memStore(on, {})
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 40)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'error' })
  await clock.advance(200_000)
  expect(w.writes).toEqual([])
})

test('the exit is held (the engine\'s limit dialog): after the grace the process is ended so the launcher can resume', async ($, on) => {
  mock.env(on, launcherEnv)
  memStore(on, {})
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 95)
  await clock.advance(1)
  expect(w.commands).toEqual(['exit'])
  expect(w.runs).toEqual([])
  await clock.advance(5_000)
  expect(w.runs).toEqual([['sh', '-c', 'kill -TERM "$PPID"']])
})

test('a full window read before the launcher environment was known is on record once the session starts', async ($, on) => {
  mock.env(on, launcherEnv)
  const store = memStore(on, {})
  mock.clock(on, { now: T0 })
  world(on, { limits: [{ kind: 'seven_day', percentUsed: 100, resetsAt: iso(T0 + 3 * 24 * HOUR) }] })
  await start($)
  expect(store['ledger:a']).toEqual({ seenAt: T0, windows: { seven_day: { percentUsed: 100, resetsAt: iso(T0 + 3 * 24 * HOUR) } } })
})

test('resumed by a switch: restores the model and continues', async ($, on) => {
  mock.env(on, { ...launcherEnv, CLAUDE_ORG: 'b' })
  mock.store(on, { [`resume:${SID}`]: { go: true, model: 'claude-opus-5-5' } })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { model: 'claude-fable-5-2' })
  await start($)
  await clock.advance(1001)
  expect(w.model).toBe('claude-opus-5-5')
  expect(w.prompts).toEqual(['继续'])
})

test('a new session nothing was said in switches to a fresh session', async ($, on) => {
  mock.env(on, { ...launcherEnv, CLAUDE_ORG_RESUMED: '' })
  const store = memStore(on, {})
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 100)
  await clock.advance(1)
  expect(w.writes[0]?.text).toBe('next=b\nfresh=1\nreason=a: 5h window at 100%\n')
  expect(Object.keys(store).filter(k => k.startsWith('resume:'))).toEqual([])
})

test('/org shows this org and the last reading of the others', async ($, on) => {
  mock.env(on, launcherEnv)
  mock.store(on, { 'ledger:b': { seenAt: T0 - 10 * MIN, windows: { five_hour: { percentUsed: 12, resetsAt: iso(T0 + 50 * MIN) } } } })
  mock.clock(on, { now: T0 })
  world(on)
  await start($)
  await measure($, 42)
  expect((await org($, '')).text).toBe(
    [
      'on: a   orgs: a, b   switch at 95%   context: 3% (compacts on switch from 50%)',
      'a now: 5h 42% (resets in 1.0 h), 7d 50% (resets in 3 d)',
      'b (last seen 10 min ago): 5h 12% (resets in 50 min)',
    ].join('\n'),
  )
})

test('/org switch moves by hand; a name the launcher did not list is refused', async ($, on) => {
  mock.env(on, launcherEnv)
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  expect((await org($, 'switch zz')).text).toBe('usage: /org [status] | /org switch [org]   (orgs: a, b)')
  expect((await org($, 'switch')).text).toBe('org-switch: exiting so this session resumes under b.')
  await clock.advance(1)
  expect(w.writes[0]?.text).toBe(`next=b\nsession=${SID}\nreason=manual /org switch\n`)
})

// ---- saving quota: the soft threshold ----

const step = async ($: Engine, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max') => {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-fable-5-2', effort, messageCount: 1 })) void _
}

test('one level less effort, never below medium', () => {
  expect(['max', 'xhigh', 'high', 'medium', 'low'].map(e => lowerEffort(e as 'max'))).toEqual(['xhigh', 'high', 'medium', 'medium', 'low'])
})

test('window from 79% to 81%: one level less effort, saving mark set; medium stays medium', async ($, on) => {
  mock.env(on, launcherEnv)
  const store = memStore(on)
  mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 79)
  await step($, 'high')
  expect(store['saving:a']).toBeUndefined()
  await measure($, 81)
  await step($, 'high')
  await step($, 'medium')
  expect(w.efforts).toEqual(['high', 'medium', 'medium'])
  expect(store['saving:a']).toEqual({ since: T0, softAt: 80 })
  expect(w.status).toBe('a · 5h 81% · 7d 50% · 省额度')
})

test('soft threshold comes from CLAUDE_ORG_SOFT_PCT', async ($, on) => {
  mock.env(on, { ...launcherEnv, CLAUDE_ORG_SOFT_PCT: '60' })
  mock.store(on)
  mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 61)
  await step($, 'max')
  expect(w.efforts).toEqual(['xhigh'])
})

test('window reset, reading back low: effort as before, saving mark gone', async ($, on) => {
  mock.env(on, launcherEnv)
  const store = memStore(on)
  mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 85)
  await step($, 'xhigh')
  await measure($, 4)
  await step($, 'xhigh')
  expect(w.efforts).toEqual(['high', 'xhigh'])
  expect(store['saving:a']).toBeUndefined()
  expect(w.status).toBe('a · 5h 4% · 7d 50%')
})

// ---- every org limited: Codex takes over ----

/** The check whether Codex may take over here. By default the engine answers "not in a git repository". */
const isReadyCheck = (argv: readonly string[]) => argv[0] === 'sh' && argv[1] === '-c' && argv[2] === CODEX_READY_SH
const NOT_A_REPO: Run = { exitCode: 3 }
const ready = (exitCode: number) => (argv: readonly string[]): Run => (isReadyCheck(argv) ? { exitCode } : { exitCode: 0 })
const allLimited = (resetIn: number) => ({
  'ledger:b': { seenAt: T0, windows: { five_hour: { percentUsed: 100, resetsAt: iso(T0 + resetIn) } } },
})
const limitedHere = ($: Engine, resetIn: number) =>
  $.session.measure({
    context: { window: 200_000, tokens: 2_000, percent: 1 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(T0 + resetIn) }],
    changed: ['rateLimits'],
  })

test('every org limited, the first frees in 10 min: no Codex, just wait', async ($, on) => {
  mock.env(on, launcherEnv)
  mock.store(on, allLimited(2 * HOUR))
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { run: ready(0) })
  await start($)
  await limitedHere($, 10 * MIN)
  await rateLimited($)
  await clock.advance(1)
  expect(w.runs.filter(isReadyCheck)).toEqual([])
  expect(w.writes).toEqual([])
  expect(w.toasts[w.toasts.length - 1]).toBe('org-switch: every org is limited. a frees in 10 min; continuing then.')
})

test('every org limited for 2 h, repository ready: hands over to Codex until the first org frees, then exits', async ($, on) => {
  mock.env(on, launcherEnv)
  const store = memStore(on, allLimited(2 * HOUR))
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { model: 'claude-fable-5-2', run: ready(0) })
  await start($)
  await limitedHere($, 3 * HOUR)
  await rateLimited($)
  await clock.advance(1)
  expect(w.writes).toEqual([
    { path: HANDOFF, text: `next=b\nsession=${SID}\ncodex=1\nuntil=${(T0 + 2 * HOUR) / 1000}\nreason=every org limited; Codex works until b frees in 2.0 h\n` },
  ])
  expect(w.commands).toEqual(['exit']) // no /compact: every org is limited
  expect(store[`resume:${SID}`]).toEqual({ go: true, model: 'claude-fable-5-2' })
  expect(w.prompts).toEqual([])
})

for (const [rc, why] of [
  [3, 'this directory is not in a git repository'],
  [4, 'the repository has no .handoff.md'],
  [5, 'the working tree has uncommitted changes'],
  [6, 'the codex command is not installed'],
] as const) {
  test(`every org limited for 2 h, but ${why}: no Codex, says why and waits`, async ($, on) => {
    mock.env(on, launcherEnv)
    mock.store(on, allLimited(2 * HOUR))
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, { run: ready(rc) })
    await start($)
    await limitedHere($, 3 * HOUR)
    await rateLimited($)
    await clock.advance(1)
    expect(w.writes).toEqual([])
    expect(w.commands).toEqual([])
    expect(w.toasts.slice(-2)).toEqual([
      `org-switch: every org is limited for a while, but Codex was not started: ${why}. Waiting instead.`,
      'org-switch: every org is limited. b frees in 2.0 h; retrying in 30 min for a reset.',
    ])
  })
}

test('not started by the launcher: a limit hands nothing to Codex', async ($, on) => {
  mock.env(on, {})
  mock.store(on, allLimited(2 * HOUR))
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { run: ready(0) })
  await start($)
  await limitedHere($, 3 * HOUR)
  await rateLimited($)
  await clock.advance(1)
  expect(w.runs).toEqual([])
  expect(w.writes).toEqual([])
})

test('resumed after Codex (non-zero exit): restores the model and says what Codex left, with its exit code, instead of "继续"', async ($, on) => {
  mock.env(on, { ...launcherEnv, CLAUDE_ORG: 'b', CLAUDE_ORG_CODEX_EXIT: '3' })
  const store = memStore(on, { [`resume:${SID}`]: { go: true, model: 'claude-fable-5-2' } })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await clock.advance(1001)
  expect(w.model).toBe('claude-fable-5-2')
  expect(w.prompts).toEqual([codexText('3')])
  expect(w.prompts[0]).toContain('退出码 3')
  for (const part of ['没有提交', 'git status', 'git diff', '.codex-takeover-notes.md']) expect(w.prompts[0]).toContain(part)
  expect(store[`resume:${SID}`]).toBeUndefined()
})

test('resumed after Codex, then every org limited again: the dirty tree stops a second takeover', async ($, on) => {
  mock.env(on, { ...launcherEnv, CLAUDE_ORG_CODEX_EXIT: '0' })
  mock.store(on, allLimited(2 * HOUR))
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { run: ready(5) }) // Codex's changes and notes are still uncommitted
  await start($)
  await clock.advance(1001)
  await limitedHere($, 3 * HOUR)
  await rateLimited($)
  await clock.advance(1)
  expect(w.runs.filter(isReadyCheck).length).toBe(1)
  expect(w.writes).toEqual([])
  expect(w.commands).toEqual([])
  expect(w.toasts.some(t => t.includes('Codex was not started: the working tree has uncommitted changes'))).toBe(true)
})

// ---- Fable back after a downgrade ----

test('downgraded to Opus, Fable hold expires: back on Fable before the next turn', async ($, on) => {
  mock.env(on, launcherEnv)
  const store = memStore(on, { 'block:b': { kind: 'fable', until: T0 + 10 * MIN } })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { model: 'claude-fable-5-2' })
  await start($)
  await measure($, 40)
  await rateLimited($)
  await clock.advance(1)
  expect(w.model).toBe('claude-opus-5-5')
  expect(store['downgrade']).toEqual({ from: 'claude-fable-5-2' })
  await $.prompt.submit({ text: 'next unit' })
  expect(w.model).toBe('claude-opus-5-5') // still held off
  await clock.advance(31 * MIN)
  expect(w.model).toBe('claude-fable-5-2')
  expect(w.commands.slice(-1)).toEqual(['model claude-fable-5-2'])
  expect(store['downgrade']).toBeUndefined()
})

test('downgraded to Opus: back on Fable the moment its hold ends, not 5 s later', async ($, on) => {
  mock.env(on, launcherEnv)
  mock.store(on, { 'block:b': { kind: 'fable', until: T0 + 10 * MIN } })
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { model: 'claude-fable-5-2' })
  await start($)
  await measure($, 40)
  await rateLimited($)
  await clock.advance(1)
  expect(w.model).toBe('claude-opus-5-5')
  await clock.advance(30 * MIN)
  expect(w.model).toBe('claude-fable-5-2')
})

// ---- not started by the launcher, CLAUDE_ORG set (a T3 Code instance): record only ----

const recordEnv = { CLAUDE_ORG: 'a', CLAUDE_ORGS: 'a,b' }
const nothingDone = (w: World, store: Record<string, unknown>) => {
  expect(w.writes).toEqual([])
  expect(w.commands).toEqual([])
  expect(w.runs).toEqual([])
  expect(w.prompts).toEqual([])
  expect(Object.keys(store).filter(k => k === 'lastSwitchAt' || k.startsWith('resume:') || k.startsWith('block:') || k === 'downgrade')).toEqual([])
}

for (const pct of [95, 100]) {
  test(`record only: window at ${pct}% records the reading and does nothing else`, async ($, on) => {
    mock.env(on, recordEnv)
    const store = memStore(on)
    const clock = mock.clock(on, { now: T0 })
    const w = world(on, { run: ready(0) })
    await start($)
    await measure($, pct)
    await clock.advance(10 * MIN)
    nothingDone(w, store)
    expect((store['ledger:a'] as { windows: Record<string, { percentUsed: number }> }).windows.five_hour?.percentUsed).toBe(pct)
    expect(w.status).toBe(`a · 5h ${pct}% · 7d 50% · 省额度`)
  })
}

test('record only: a turn ended by an error or a limit failure at 100% does nothing', async ($, on) => {
  mock.env(on, recordEnv)
  const store = memStore(on, allLimited(2 * HOUR))
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { model: 'claude-fable-5-2', run: ready(0) })
  await start($)
  await measure($, 100)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'error' })
  await rateLimited($)
  await clock.advance(3 * HOUR)
  nothingDone(w, store)
  expect(w.model).toBe('claude-fable-5-2')
  expect(store['ledger:a']).toBeDefined()
})

test('record only: a full window is on record from the start', async ($, on) => {
  mock.env(on, recordEnv)
  const store = memStore(on)
  mock.clock(on, { now: T0 })
  const w = world(on, { limits: [{ kind: 'seven_day', percentUsed: 100, resetsAt: iso(T0 + 3 * 24 * HOUR) }] })
  await start($)
  expect(store['ledger:a']).toEqual({ seenAt: T0, windows: { seven_day: { percentUsed: 100, resetsAt: iso(T0 + 3 * 24 * HOUR) } } })
  expect(store['saving:a']).toEqual({ since: T0, softAt: 80 })
  expect(w.status).toBe('a · 7d 100% · 省额度')
})

test('record only: past the soft threshold, one level less effort', async ($, on) => {
  mock.env(on, recordEnv)
  const store = memStore(on)
  mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 81)
  await step($, 'high')
  expect(w.efforts).toEqual(['medium'])
  expect(store['saving:a']).toEqual({ since: T0, softAt: 80 })
})

test('record only: /org shows the status; /org switch says to change the thread\'s model instance', async ($, on) => {
  mock.env(on, recordEnv)
  const store = memStore(on)
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await start($)
  await measure($, 42)
  expect((await org($, '')).text?.split('\n')[1]).toBe('a now: 5h 42% (resets in 1.0 h), 7d 50% (resets in 3 d)')
  expect((await org($, 'switch')).text).toBe(RECORD_ONLY_SWITCH)
  expect((await org($, 'switch b')).text).toBe(RECORD_ONLY_SWITCH)
  await clock.advance(10 * MIN)
  nothingDone(w, store)
  expect(w.toasts).toEqual([])
})

test('no CLAUDE_ORG: nothing recorded', async ($, on) => {
  mock.env(on, { CLAUDE_ORGS: 'a,b' })
  const store = memStore(on)
  mock.clock(on, { now: T0 })
  const w = world(on, { limits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: iso(T0 + HOUR) }] })
  await start($)
  await measure($, 96)
  expect(store).toEqual({})
  expect(w.status).toBe('')
  expect((await org($, 'switch')).text).toBe('org-switch: this session was not started by claude-org; nothing to switch.')
})
