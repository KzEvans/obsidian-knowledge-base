/** The one Electron API this module uses (Electron ≥ 32 removed File.path). Not part of Obsidian's types. */
declare module 'electron' {
  export const webUtils: { getPathForFile(file: File): string };
}
