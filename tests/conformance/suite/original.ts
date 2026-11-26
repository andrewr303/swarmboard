// Conformance case CF-20: the ten ported original checks (HS-87), one test each on a fresh board.
import type { Suite } from '../contract.ts'
import { ORIGINAL_CHECKS } from '../original-checks.ts'

export const ORIGINAL_SUITE: Suite = {
  'CF-20': ORIGINAL_CHECKS.map((check) => ({
    name: `HS-87 original :${check.line} ${check.name}`,
    async run(ctx) {
      const board = await ctx.open()
      await check.run(board)
    },
  })),
}
