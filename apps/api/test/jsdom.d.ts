declare module 'jsdom' {
  type ParsedDocument = {
    querySelector(selector: string): { textContent: string | null } | null;
    documentElement: { getAttribute(name: string): string | null };
  };
  export class JSDOM {
    constructor(html?: string);
    window: {
      DOMParser: new () => { parseFromString(value: string, type: string): ParsedDocument };
    };
  }
}
