/**
 * Detects a repeating tool-call pattern across recent turns.
 * Returns true if the last 3 turns all invoked the same set of tools.
 */
export function detectLoop(recentToolNames: string[][]): boolean {
  if (recentToolNames.length < 3) return false;
  const last3 = recentToolNames.slice(-3);
  const sig = (names: string[]) => JSON.stringify([...names].sort());
  return sig(last3[0]) === sig(last3[1]) && sig(last3[1]) === sig(last3[2]);
}
