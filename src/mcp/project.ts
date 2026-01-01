export function resolveProject(project?: string, sessionDefault?: string): string {
  const envDefault = process.env.MEMORANTADO_PROJECT?.trim() || "global";
  const defaultProject = sessionDefault?.trim() || envDefault;
  const p = (project ?? defaultProject).trim();
  return p.length ? p : defaultProject;
}
