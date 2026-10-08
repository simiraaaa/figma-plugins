/** esbuild の --loader:.md=text で、.md の import は本文の文字列になる */
declare module "*.md" {
  const content: string;
  export default content;
}
