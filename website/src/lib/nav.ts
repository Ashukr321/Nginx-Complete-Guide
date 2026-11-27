/** Slim, serialisable navigation data passed from server to client components. */
export type NavDoc = { slug: string; title: string; group?: string };
export type NavCategory = { slug: string; title: string; docs: NavDoc[] };
