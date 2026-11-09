export function trimIconWeights(code: string, opts?: { keepDuotone?: boolean }): string | null;
export function duotoneIcons(sources: string[]): Set<string> | null;
export function iconDefsName(id: string): string | null;
export function staticClosure(chunks: Record<string, { imports?: string[] }>, start: string[]): string[];
export function shellPreloadLinks(files: { entry: string[]; phone: string[]; desktop: string[] }): { href: string; media?: string }[];
export function sharedChunkNames(chunks: { fileName: string; isEntry: boolean; isDynamicEntry: boolean; imports: string[]; moduleIds: string[] }[], rules: { isShell: (id: string) => boolean; isBackground?: (id: string) => boolean; isPinned?: (id: string) => boolean }): Map<string, 'index' | 'views'>;
export const PHONE_MEDIA: string;
export const DESKTOP_MEDIA: string;
