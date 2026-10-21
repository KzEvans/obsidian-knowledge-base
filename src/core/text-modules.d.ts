/** Markdown bundled as text by esbuild (and by the test loader in tests/setup.ts). */
declare module '*.md' {
  const text: string;
  export default text;
}
