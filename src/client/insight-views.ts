export const insightViews = ['progress', 'activity', 'unanswered', 'blockers'] as const
export type InsightView = typeof insightViews[number]

export function isInsightView(value: string | undefined): value is InsightView {
  return insightViews.some(view => view === value)
}
