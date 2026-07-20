/** Build a compare URL for creating a pull request from a remote URL and branch. */
export function buildPRUrl(remoteUrl: string, branch: string, baseBranch = "main"): string | null {
  let base: string | null = null;
  const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) base = `https://${sshMatch[1]}/${sshMatch[2]}`;
  const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) base = `https://${httpsMatch[1]}/${httpsMatch[2]}`;
  if (!base) return null;
  return `${base}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}`;
}
