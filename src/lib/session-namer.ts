export async function generateSessionTitle(prompt: string): Promise<string> {
  return (
    prompt
      .split("\n")[0]
      ?.replace(/^\s*["']?/, "")
      .replace(/["']?\s*$/, "")
      .trim()
      .slice(0, 80) || "New Session"
  );
}
