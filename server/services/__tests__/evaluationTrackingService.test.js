const {
  runTrackedEvaluation,
  listActiveEvaluations,
  summarizeStrategy,
} = require('../evaluationTrackingService');

describe('evaluationTrackingService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('tracks completion metadata for successful evaluations', async () => {
    const handler = jest.fn(async () => ({
      summary: 'done',
    }));
    const { id, job, result } = await runTrackedEvaluation({
      metadata: { strategyName: 'Test strategy', requester: 'user-1' },
      handler,
    });
    expect(result).toEqual({ summary: 'done' });
    expect(job.status).toBe('completed');

    const active = listActiveEvaluations().find((entry) => entry.id === id);
    expect(active).toBeDefined();
    expect(active.status).toBe('completed');
    expect(active.strategyName).toBe('Test strategy');

    jest.runOnlyPendingTimers();
    const afterCleanup = listActiveEvaluations().find((entry) => entry.id === id);
    expect(afterCleanup).toBeUndefined();
  });

  it('records failures when the handler throws', async () => {
    const handler = jest.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      runTrackedEvaluation({
        metadata: { strategyName: 'Fails', requester: 'user-1' },
        handler,
      })
    ).rejects.toThrow('boom');

    const failedEntry = listActiveEvaluations().find(
      (entry) => entry.strategyName === 'Fails'
    );
    expect(failedEntry).toBeDefined();
    expect(failedEntry.status).toBe('failed');
    expect(failedEntry.error).toBe('boom');
  });

  it('summarizes defsymphony scripts and group detection', () => {
    const summary = summarizeStrategy(
      `(defsymphony "Demo" {}
        (group "Alpha" [(asset "SPY")])
        (asset "QQQ"))`
    );
    expect(summary.name).toBe('Demo');
    expect(summary.hasGroup).toBe(true);

    const fallback = summarizeStrategy('');
    expect(fallback.name).toBe('Unknown strategy');
    expect(fallback.hasGroup).toBe(false);
  });
});
