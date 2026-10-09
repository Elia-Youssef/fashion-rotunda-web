// Bound shader warmup so a stalled compilation cannot leave startup waiting indefinitely.
export const SHADER_COMPILATION_DEADLINE_MS = 15_000;

export async function withCompilationDeadline<T>(compilation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Shader compilation timed out')), SHADER_COMPILATION_DEADLINE_MS);
  });
  try {
    return await Promise.race([compilation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
