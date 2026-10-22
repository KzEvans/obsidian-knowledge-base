import { Modal } from 'obsidian';
import type { App } from 'obsidian';

export class FigureModal extends Modal {
  constructor(app: App, private readonly url: string, private readonly caption: string) { super(app); }
  override onOpen(): void {
    this.modalEl.addClass('pdf-reader-figure-modal');
    this.contentEl.createEl('img', { attr: { src: this.url, alt: this.caption || '原文图表' } });
    this.contentEl.createEl('p', { text: this.caption });
  }
  override onClose(): void { this.contentEl.empty(); }
}

export class MessageModal extends Modal {
  constructor(app: App, private readonly messages: readonly string[]) { super(app); }
  override onOpen(): void {
    this.setTitle('原文核对提示');
    const list = this.contentEl.createEl('ul');
    for (const message of this.messages) list.createEl('li', { text: message });
  }
  override onClose(): void { this.contentEl.empty(); }
}

/** Asks before a PDF outside the library is sent to MinerU. */
export class ConfirmModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly message: string, private readonly confirm: string, private readonly onConfirm: () => void) { super(app); }
  override onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl('p', { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: this.confirm, cls: 'mod-cta' }).addEventListener('click', () => { this.close(); this.onConfirm(); });
    buttons.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
  }
  override onClose(): void { this.contentEl.empty(); }
}
