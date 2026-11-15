const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

export function displayPath(path: string, workspace: string | null | undefined): string {
  const file = norm(path);
  if (!workspace) return file;
  const root = norm(workspace);
  const sameCase = file.startsWith(`${root}/`);
  const caseless = !sameCase && file.toLowerCase().startsWith(`${root.toLowerCase()}/`);
  return sameCase || caseless ? file.slice(root.length + 1) : file;
}

export function baseName(path: string): string {
  const file = norm(path);
  return file.slice(file.lastIndexOf("/") + 1);
}
