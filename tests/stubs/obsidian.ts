/* Minimal runtime stand-ins for the `obsidian` module in Node tests. Extend only as tests need. */
export class Notice { constructor(readonly message: string) { notices.push(message); } }
export const notices: string[] = [];

export class Setting {
  constructor(readonly containerEl: unknown) {}
  setName(): this { return this; }
  setDesc(): this { return this; }
  addText(): this { return this; }
  addTextArea(): this { return this; }
  addButton(): this { return this; }
  addToggle(): this { return this; }
  addSlider(): this { return this; }
  addDropdown(): this { return this; }
}

export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class TFile {}
export class FileSystemAdapter {}

export function setIcon(): void {}
export function loadPdfJs(): Promise<never> { return Promise.reject(new Error('pdf.js is not available in unit tests')); }
export function requestUrl(): Promise<never> { return Promise.reject(new Error('network is not available in unit tests')); }
export class MarkdownView {}
export class MarkdownRenderer {}
export class TFolder {}

export function normalizePath(value: string): string { return value.replace(/\\/g, '/').replace(/\/+/g, '/'); }
