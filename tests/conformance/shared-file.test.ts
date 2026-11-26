// HS-187: full conformance catalogue (CF-01..CF-20, 0 skipped) on Mode 1 `shared-file` (real FileHost),
// including cross-mode output parity (CF-12) against `in-process` and CF-05 B4-2 busy-injected retry.
import { afterAll } from 'vitest'
import { defineTransportConformance } from './contract.ts'
import { inProcessTarget, removeTempDirs } from './fixtures.ts'
import { sharedFileTarget } from './host-stub.ts'

defineTransportConformance(sharedFileTarget('real'), {
  parity: inProcessTarget(),
  crossProcessWake: true,
})

afterAll(() => {
  removeTempDirs()
})
