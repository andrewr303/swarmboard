// HS-54: the types derived from the registry and the core. The checks are compile-time (pnpm typecheck compiles
// this file); the test body only runs the value-level assignments.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AgentInboxView,
  ChannelTreePage,
  ClaimedNext,
  EventsPage,
  GroupView,
  NotificationsPage,
  PinView,
  Posted,
  PresenceView,
} from '../../src/core/public.ts'
import type { OpInput, OpName, OpOutput } from '../../src/client/ops.ts'

describe('registry types', () => {
  it('HS-54 OpInput and OpOutput follow the bound method and schema', () => {
    expectTypeOf<OpInput<'post'>['channel']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<OpInput<'post'>['text']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<OpInput<'post'>>().toHaveProperty('channel')
    expectTypeOf<OpInput<'post'>>().toHaveProperty('quoteMessageId')
    expectTypeOf<OpOutput<'post'>>().toEqualTypeOf<Posted>()
    expectTypeOf<OpInput<'edit'>['id']>().toEqualTypeOf<string | number>()
    expectTypeOf<OpOutput<'events'>>().toEqualTypeOf<EventsPage>()
    expectTypeOf<OpOutput<'claimReadyTask'>>().toEqualTypeOf<ClaimedNext>()

    // v2 social ops types
    expectTypeOf<OpOutput<'channelTree'>>().toEqualTypeOf<ChannelTreePage>()
    expectTypeOf<OpOutput<'agentInbox'>>().toEqualTypeOf<AgentInboxView>()
    expectTypeOf<OpOutput<'waitNotifications'>>().toEqualTypeOf<NotificationsPage>()
    expectTypeOf<OpOutput<'group'>>().toEqualTypeOf<GroupView>()
    expectTypeOf<OpOutput<'pins'>>().toEqualTypeOf<PinView[]>()
    expectTypeOf<OpOutput<'presence'>>().toEqualTypeOf<PresenceView[]>()
    expectTypeOf<OpInput<'group'>['handle']>().toEqualTypeOf<string>()
    expectTypeOf<OpInput<'pinMessage'>['id']>().toEqualTypeOf<string | number>()
    expectTypeOf<OpInput<'ackNotification'>['id']>().toEqualTypeOf<string>()
    // @ts-expect-error handle is required for group
    const noHandle: OpInput<'group'> = {}
    const validGroup: OpInput<'group'> = { handle: 'reviewers' }

    // inbox: key required, channel and limit optional
    expectTypeOf<OpInput<'inbox'>['key']>().toEqualTypeOf<string>()
    expectTypeOf<OpInput<'inbox'>['channel']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<OpInput<'inbox'>['limit']>().toEqualTypeOf<number | undefined>()
    // @ts-expect-error key is required
    const noKey: OpInput<'inbox'> = {}
    const inbox: OpInput<'inbox'> = { key: 'k' }

    // upload: data accepts Uint8Array
    const upload: OpInput<'upload'> = { name: 'a', type: null, data: new Uint8Array(2) }
    expectTypeOf<Uint8Array>().toExtend<OpInput<'upload'>['data']>()

    // me takes nothing
    const me: OpInput<'me'> = {}
    // @ts-expect-error me has no fields
    const meBad: OpInput<'me'> = { x: 1 }

    expectTypeOf<OpName>().toEqualTypeOf<keyof typeof import('../../src/client/ops.ts').OPS>()
    expect([noKey, inbox, upload, me, meBad, noHandle, validGroup]).toHaveLength(7)
  })
})
