export async function runJobsWithConcurrency<T>(
  jobs: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results = Array.from<T>({ length: jobs.length });
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (nextIndex < jobs.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await jobs[currentIndex]!();
      }
    }),
  );
  return results;
}
