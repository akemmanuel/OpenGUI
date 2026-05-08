declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}

declare module "*.css?url" {
  const href: string;
  export default href;
}
